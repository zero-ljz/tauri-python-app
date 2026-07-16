use anyhow::Result;
use log::{debug, error, info, warn};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::events::backend_event_name;

const MAX_BACKEND_LOGS: usize = 500;
const MAX_PROTOCOL_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_LOG_LINE_BYTES: usize = 64 * 1024;

/// stdin 消息发送端的共享类型别名。
/// - Option::None  → 进程未运行，写入会立即报错
/// - Option::Some  → 进程运行中，消息投入队列后由 writer 任务异步写入
pub type StdinTx = Arc<StdMutex<Option<mpsc::Sender<Vec<u8>>>>>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendPhase {
    Stopped,
    Starting,
    Ready,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackendStatusPayload {
    pub phase: BackendPhase,
    pub generation: u64,
    pub running: bool,
    pub ready: bool,
    pub version: Option<String>,
    pub capabilities: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug)]
struct BackendHealthState {
    phase: BackendPhase,
    generation: u64,
    version: Option<String>,
    capabilities: Vec<String>,
    last_error: Option<String>,
}

/// Shared backend lifecycle state. Process spawn and protocol readiness are
/// deliberately separate: the backend is only ready after its handshake.
pub struct BackendHealth {
    state: StdMutex<BackendHealthState>,
    ready_tx: watch::Sender<bool>,
}

impl BackendHealth {
    pub fn new() -> Self {
        let (ready_tx, _ready_rx) = watch::channel(false);
        Self {
            state: StdMutex::new(BackendHealthState {
                phase: BackendPhase::Stopped,
                generation: 0,
                version: None,
                capabilities: Vec::new(),
                last_error: None,
            }),
            ready_tx,
        }
    }

    pub fn subscribe_ready(&self) -> watch::Receiver<bool> {
        self.ready_tx.subscribe()
    }

    pub fn begin_start(&self) -> u64 {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        state.generation += 1;
        state.phase = BackendPhase::Starting;
        state.version = None;
        state.capabilities.clear();
        state.last_error = None;
        let _ = self.ready_tx.send(false);
        state.generation
    }

    pub fn mark_ready(&self, generation: u64, payload: &Value) -> bool {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        if state.generation != generation || !matches!(state.phase, BackendPhase::Starting) {
            return false;
        }

        state.phase = BackendPhase::Ready;
        state.version = payload
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned);
        state.capabilities = payload
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let _ = self.ready_tx.send(true);
        true
    }

    pub fn begin_stop(&self) -> u64 {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        state.phase = BackendPhase::Stopping;
        let _ = self.ready_tx.send(false);
        state.generation
    }

    pub fn mark_stopped(&self, generation: u64, reason: Option<String>) -> bool {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        if state.generation != generation
            || matches!(state.phase, BackendPhase::Stopped | BackendPhase::Failed)
        {
            return false;
        }
        state.phase = if reason.is_some() {
            BackendPhase::Failed
        } else {
            BackendPhase::Stopped
        };
        state.version = None;
        state.capabilities.clear();
        state.last_error = reason;
        let _ = self.ready_tx.send(false);
        true
    }

    pub fn fail_current(&self, generation: u64, reason: String) {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        if state.generation != generation {
            return;
        }
        state.phase = BackendPhase::Failed;
        state.version = None;
        state.capabilities.clear();
        state.last_error = Some(reason);
        let _ = self.ready_tx.send(false);
    }

    pub fn is_running(&self) -> bool {
        let state = self.state.lock().expect("backend health lock poisoned");
        matches!(
            state.phase,
            BackendPhase::Starting | BackendPhase::Ready | BackendPhase::Stopping
        )
    }

    pub fn snapshot(&self) -> BackendStatusPayload {
        let state = self.state.lock().expect("backend health lock poisoned");
        BackendStatusPayload {
            phase: state.phase.clone(),
            generation: state.generation,
            running: matches!(
                state.phase,
                BackendPhase::Starting | BackendPhase::Ready | BackendPhase::Stopping
            ),
            ready: matches!(state.phase, BackendPhase::Ready),
            version: state.version.clone(),
            capabilities: state.capabilities.clone(),
            last_error: state.last_error.clone(),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct BackendLogPayload {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub level: &'static str,
    pub stream: &'static str,
    pub source: &'static str,
    pub message: String,
}

type BackendLogBuffer = Arc<StdMutex<VecDeque<BackendLogPayload>>>;

#[cfg(windows)]
fn venv_python_path(venv_dir: PathBuf) -> PathBuf {
    venv_dir.join("Scripts").join("python.exe")
}

#[cfg(not(windows))]
fn venv_python_path(venv_dir: PathBuf) -> PathBuf {
    venv_dir.join("bin").join("python")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn stderr_level(line: &str) -> &'static str {
    let upper = line.to_ascii_uppercase();
    if upper.contains("[ERROR]") || upper.starts_with("ERROR") {
        "error"
    } else if upper.contains("[WARNING]") || upper.contains("[WARN]") || upper.starts_with("WARN") {
        "warning"
    } else if upper.contains("[DEBUG]") || upper.starts_with("DEBUG") {
        "debug"
    } else {
        "info"
    }
}

fn emit_backend_log(
    app: &AppHandle,
    logs: &BackendLogBuffer,
    next_log_seq: &Arc<AtomicU64>,
    source: &'static str,
    stream: &'static str,
    message: String,
) {
    let level = if stream == "stderr" {
        stderr_level(&message)
    } else {
        // "process" stream 用于管道级错误（CommandEvent::Error），归类为 error 级别
        "error"
    };

    let payload = BackendLogPayload {
        seq: next_log_seq.fetch_add(1, Ordering::SeqCst) + 1,
        timestamp_ms: now_ms(),
        level,
        stream,
        source,
        message,
    };

    if let Ok(mut buffer) = logs.lock() {
        buffer.push_back(payload.clone());
        while buffer.len() > MAX_BACKEND_LOGS {
            buffer.pop_front();
        }
    } else {
        warn!("[BackendRuntime] 写入 Backend 日志缓冲区失败");
    }

    if let Err(e) = app.emit(&backend_event_name("backend.log"), payload) {
        warn!("[BackendRuntime] 转发 Backend 日志失败: {}", e);
    }
}

fn take_complete_lines(buffer: &mut Vec<u8>, chunk: &[u8], max_line_bytes: usize) -> Vec<String> {
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();

    while let Some(newline_pos) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut line = buffer.drain(..=newline_pos).collect::<Vec<_>>();
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if !line.is_empty() && line.len() <= max_line_bytes {
            lines.push(String::from_utf8_lossy(&line).to_string());
        } else if line.len() > max_line_bytes {
            warn!("[BackendRuntime] 丢弃超过 {} 字节的输出帧", max_line_bytes);
        }
    }

    if buffer.len() > max_line_bytes {
        warn!("[BackendRuntime] 丢弃未终止且过大的输出帧");
        buffer.clear();
    }

    lines
}

fn take_remaining_line(buffer: &mut Vec<u8>) -> Option<String> {
    if buffer.is_empty() {
        return None;
    }

    let mut line = std::mem::take(buffer);
    while line
        .last()
        .copied()
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
    {
        line.pop();
    }

    if line.is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(&line).to_string())
    }
}

fn handle_stdout_line(line: &str, on_message: &Arc<dyn Fn(Value) + Send + Sync>, source: &str) {
    debug!("[backend stdout ({})] {}", source, line);
    match serde_json::from_str::<Value>(line) {
        Ok(msg) => (on_message)(msg),
        Err(e) => warn!("[BackendRuntime] JSON 解析失败: {} — 原始数据: {}", e, line),
    }
}

/// Fix 2：stdin 写入已从 ActiveProcess 中解耦，由独立的 writer 任务负责；
/// ActiveProcess 仅保留进程句柄用于 kill 操作。
pub enum ActiveProcess {
    /// 生产发布模式：Tauri 托管的二进制 Backend
    /// CommandChild::write 取 &mut self，kill 取 self，用 Arc<StdMutex<>> 共享给 writer 任务
    Backend {
        child: Arc<StdMutex<Option<CommandChild>>>,
        pid: u32,
    },
    /// 本地开发模式：直连系统的 Python 解释器（stdin 已被 writer 任务独占消费）
    Dev { child: Box<tokio::process::Child> },
}

impl ActiveProcess {
    /// 统一抽象安全终止进程的方法
    pub async fn kill(self) -> Result<()> {
        match self {
            ActiveProcess::Backend { child, pid } => {
                // PyInstaller onefile runs a bootloader parent and a Python child.
                // Kill the whole tree; CommandChild::kill only targets the parent.
                force_kill_pid(pid)?;
                if let Ok(mut child_slot) = child.try_lock() {
                    child_slot.take();
                }
            }
            ActiveProcess::Dev { mut child } => {
                child
                    .kill()
                    .await
                    .map_err(|e| anyhow::anyhow!("终止开发 Backend 失败: {}", e))?;
            }
        }
        Ok(())
    }
}

/// 负责管理 Python Backend 进程的生命周期。
///
/// Fix 1：就绪通知从 `Notify`（单 permit，并发唤醒存在丢失）升级为
///         `watch::channel`（所有 waiter 同时广播唤醒）。
///
/// Fix 2：stdin 写入通道（`stdin_tx`）以 `Arc<StdMutex<Option<>>>` 独立暴露，
///         使 `RpcClient` 直接持有并写入，完全不再需要锁住整个 `BackendRuntime`。
pub struct BackendRuntime {
    child: Option<ActiveProcess>,
    app: AppHandle,
    health: Arc<BackendHealth>,
    logs: BackendLogBuffer,
    next_log_seq: Arc<AtomicU64>,
    /// 独立 stdin 写入通道：与 BackendRuntime 锁解耦，RpcClient 可独立写入。
    stdin_tx: StdinTx,
}

impl BackendRuntime {
    pub fn new(app: AppHandle, health: Arc<BackendHealth>) -> Self {
        Self {
            child: None,
            app,
            health,
            logs: Arc::new(StdMutex::new(VecDeque::with_capacity(MAX_BACKEND_LOGS))),
            next_log_seq: Arc::new(AtomicU64::new(0)),
            stdin_tx: Arc::new(StdMutex::new(None)),
        }
    }

    /// 返回就绪状态 watch 订阅端，供 RpcClient 等外部组件监听进程启动/退出事件。
    /// 每次调用返回独立订阅端，多个 waiter 并发等待时全部同时唤醒（Fix 1 核心）。
    pub fn ready_watch(&self) -> watch::Receiver<bool> {
        self.health.subscribe_ready()
    }

    /// 返回 stdin 写入通道的共享引用，供 RpcClient 直接写入而无需锁住 BackendRuntime（Fix 2 核心）。
    pub fn stdin_sender(&self) -> StdinTx {
        Arc::clone(&self.stdin_tx)
    }

    /// 进程退出时的统一清理回调（幂等：仅在 running 从 true→false 时触发一次）。
    ///
    /// Fix 1：同步广播 ready = false，新的 waiter 立即感知进程不可用。
    /// Fix 2：清空 stdin_tx，writer 任务的 rx 端因 sender drop 而自动退出。
    fn notify_exit(
        health: &Arc<BackendHealth>,
        generation: u64,
        stdin_tx: &StdinTx,
        on_exit: &Arc<dyn Fn() + Send + Sync>,
    ) {
        if health.mark_stopped(generation, Some("Backend process exited".to_string())) {
            if let Ok(mut g) = stdin_tx.lock() {
                *g = None;
            }
            on_exit();
        }
    }

    fn resolve_dev_python() -> PathBuf {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_dir = manifest_dir.parent().unwrap_or(manifest_dir.as_path());
        let candidates = [
            workspace_dir.join(".venv"),
            manifest_dir.join(".venv"),
            workspace_dir.join("venv"),
            manifest_dir.join("venv"),
        ];

        for venv_dir in candidates {
            let python = venv_python_path(venv_dir);
            if python.is_file() {
                return python;
            }
        }

        std::env::var("PYTHON")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("python"))
    }

    fn app_data_dir(&self) -> Result<PathBuf> {
        let directory = self
            .app
            .path()
            .app_data_dir()
            .map_err(|error| anyhow::anyhow!("无法解析应用数据目录: {error}"))?;
        std::fs::create_dir_all(&directory)
            .map_err(|error| anyhow::anyhow!("无法创建应用数据目录: {error}"))?;
        Ok(directory)
    }

    /// 开发调试模式：直接调用本地 Python 解释器运行 backend 脚本。
    ///
    /// Fix 2：stdin 在此处被取出，交由独立的 writer 任务持有，不再存入 ActiveProcess。
    /// Fix 3：stdout 和 stderr 任务关闭时均触发 notify_exit（幂等），提高进程退出检测可靠性。
    async fn start_dev_process(
        &mut self,
        generation: u64,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_dir = manifest_dir.parent().unwrap_or(manifest_dir.as_path());
        let python = Self::resolve_dev_python();
        let app_data_dir = self.app_data_dir()?;
        info!("[BackendRuntime] 开发模式 Python: {}", python.display());

        let mut cmd = Command::new(&python);
        cmd.arg("-m")
            .arg("backend.main")
            .current_dir(&app_data_dir)
            .env("PYTHONPATH", workspace_dir)
            .env("TAURI_APP_DATA_DIR", &app_data_dir)
            .env("TAURI_APP_VERSION", env!("CARGO_PKG_VERSION"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "无法拉起 Python 调试进程: python={}, module=backend.main, cwd={}, error={}",
                python.display(),
                app_data_dir.display(),
                e
            )
        })?;

        // 分别取出 IO 句柄；stdin 交给 writer 任务，stdout/stderr 交给各自的 reader 任务
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("无法获取 Python stdin 管道"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("无法获取 Python stdout 管道"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("无法获取 Python stderr 管道"))?;

        // 仅保留 child 用于 kill，stdin 已由 writer 任务独占
        self.child = Some(ActiveProcess::Dev {
            child: Box::new(child),
        });

        // 建立 stdin 写入 mpsc 通道，writer 任务持有 rx 端
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
        {
            let mut g = self.stdin_tx.lock().unwrap();
            *g = Some(tx);
        }

        // ── stdin writer 任务：异步消费 mpsc 队列，写入 Python 进程的 stdin ──────────
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(bytes) = rx.recv().await {
                if stdin.write_all(&bytes).await.is_err() {
                    warn!("[BackendRuntime] Dev stdin-writer: 写入失败，退出");
                    break;
                }
                if stdin.flush().await.is_err() {
                    warn!("[BackendRuntime] Dev stdin-writer: 刷新失败，退出");
                    break;
                }
            }
            debug!("[BackendRuntime] Dev stdin-writer 任务已退出");
        });

        // ── stdout reader 任务 ────────────────────────────────────────────────────────
        let health_stdout = Arc::clone(&self.health);
        let stdin_tx_stdout = Arc::clone(&self.stdin_tx);
        let on_exit_stdout = Arc::clone(&on_exit);
        let on_message_clone = Arc::clone(&on_message);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buffer = Vec::new();
            let mut chunk = [0_u8; 8192];
            while let Ok(count) = reader.read(&mut chunk).await {
                if count == 0 {
                    break;
                }
                for line in
                    take_complete_lines(&mut buffer, &chunk[..count], MAX_PROTOCOL_LINE_BYTES)
                {
                    handle_stdout_line(&line, &on_message_clone, "dev");
                }
            }
            if let Some(line) = take_remaining_line(&mut buffer) {
                handle_stdout_line(&line, &on_message_clone, "dev");
            }
            info!("[BackendRuntime] 开发模式 stdout 管道已关闭");
            Self::notify_exit(
                &health_stdout,
                generation,
                &stdin_tx_stdout,
                &on_exit_stdout,
            );
        });

        // ── stderr reader 任务（Fix 3：关闭时也触发 notify_exit，幂等安全）────────────
        let app = self.app.clone();
        let logs = Arc::clone(&self.logs);
        let next_log_seq = Arc::clone(&self.next_log_seq);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buffer = Vec::new();
            let mut chunk = [0_u8; 8192];
            while let Ok(count) = reader.read(&mut chunk).await {
                if count == 0 {
                    break;
                }
                for line in take_complete_lines(&mut buffer, &chunk[..count], MAX_LOG_LINE_BYTES) {
                    info!("[backend stderr (dev)] {}", line);
                    emit_backend_log(&app, &logs, &next_log_seq, "dev", "stderr", line);
                }
            }
            if let Some(line) = take_remaining_line(&mut buffer) {
                emit_backend_log(&app, &logs, &next_log_seq, "dev", "stderr", line);
            }
            info!("[BackendRuntime] 开发模式 stderr 管道已关闭");
        });

        Ok(())
    }

    /// 生产发布模式：拉起 PyInstaller 打包好的 Backend 二进制程序。
    ///
    /// Fix 2：CommandChild 用 Arc 包裹共享于 writer 任务和 kill 路径；
    ///         writer 任务独立写入，不再需要锁住 BackendRuntime。
    async fn start_release_backend(
        &mut self,
        generation: u64,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let shell = self.app.shell();
        let app_data_dir = self.app_data_dir()?;
        let (mut rx, child) = shell
            .sidecar("backend")
            .map_err(|e| anyhow::anyhow!("创建 Backend 实例失败: {}", e))?
            .current_dir(&app_data_dir)
            .env("TAURI_APP_DATA_DIR", &app_data_dir)
            .env("TAURI_APP_VERSION", env!("CARGO_PKG_VERSION"))
            .spawn()
            .map_err(|e| anyhow::anyhow!("启动 Backend 进程失败: {}", e))?;

        // CommandChild::write 取 &mut self，用 Arc<StdMutex<>> 共享给 writer 任务和 kill 路径
        let child_arc = Arc::new(StdMutex::new(Some(child)));
        let child_for_writer = Arc::clone(&child_arc);

        // 建立 stdin 写入 mpsc 通道
        let (tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);
        {
            let mut g = self.stdin_tx.lock().unwrap();
            *g = Some(tx);
        }

        let pid = child_arc
            .lock()
            .map_err(|_| anyhow::anyhow!("CommandChild 锁已中毒"))?
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Backend 进程句柄缺失"))?
            .pid();
        self.child = Some(ActiveProcess::Backend {
            child: child_arc,
            pid,
        });
        // ── stdin writer 任务：锁 CommandChild，调用 write()（同步但通常极快）────────
        tokio::spawn(async move {
            while let Some(bytes) = stdin_rx.recv().await {
                let child = Arc::clone(&child_for_writer);
                let write_result = tokio::task::spawn_blocking(move || {
                    let mut child_slot = child
                        .lock()
                        .map_err(|_| anyhow::anyhow!("CommandChild 锁已中毒"))?;
                    let child = child_slot
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("Backend 进程句柄已释放"))?;
                    child.write(&bytes).map_err(anyhow::Error::from)
                })
                .await;
                if !matches!(write_result, Ok(Ok(()))) {
                    warn!("[BackendRuntime] Backend stdin-writer: 写入失败，退出");
                    break;
                }
            }
            debug!("[BackendRuntime] Backend stdin-writer 任务已退出");
        });

        // ── 事件监听任务（stdout/stderr/exit）────────────────────────────────────────
        let health = Arc::clone(&self.health);
        let stdin_tx = Arc::clone(&self.stdin_tx);
        let app = self.app.clone();
        let logs = Arc::clone(&self.logs);
        let next_log_seq = Arc::clone(&self.next_log_seq);
        tokio::spawn(async move {
            let mut stdout_buffer = Vec::new();
            let mut stderr_buffer = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(chunk) => {
                        for line in
                            take_complete_lines(&mut stdout_buffer, &chunk, MAX_PROTOCOL_LINE_BYTES)
                        {
                            handle_stdout_line(&line, &on_message, "backend");
                        }
                    }
                    CommandEvent::Stderr(chunk) => {
                        for line in
                            take_complete_lines(&mut stderr_buffer, &chunk, MAX_LOG_LINE_BYTES)
                        {
                            info!("[backend stderr] {}", line);
                            emit_backend_log(&app, &logs, &next_log_seq, "backend", "stderr", line);
                        }
                    }
                    CommandEvent::Error(e) => {
                        error!("[BackendRuntime] 进程管道错误: {}", e);
                        emit_backend_log(
                            &app,
                            &logs,
                            &next_log_seq,
                            "backend",
                            "process",
                            e.to_string(),
                        );
                    }
                    CommandEvent::Terminated(status) => {
                        if let Some(line) = take_remaining_line(&mut stdout_buffer) {
                            handle_stdout_line(&line, &on_message, "backend");
                        }
                        if let Some(line) = take_remaining_line(&mut stderr_buffer) {
                            info!("[backend stderr] {}", line);
                            emit_backend_log(&app, &logs, &next_log_seq, "backend", "stderr", line);
                        }
                        info!("[BackendRuntime] Backend 进程已退出: {:?}", status);
                        Self::notify_exit(&health, generation, &stdin_tx, &on_exit);
                        break;
                    }
                    _ => {}
                }
            }
            // 兜底：rx 通道异常关闭时也触发退出通知
            Self::notify_exit(&health, generation, &stdin_tx, &on_exit);
        });

        Ok(())
    }

    /// 启动 Python Backend 进程。
    pub async fn start(
        &mut self,
        on_message: Arc<dyn Fn(u64, Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        if self.health.is_running() {
            warn!("[BackendRuntime] Backend 进程已经在运行中");
            return Ok(());
        }

        if let Some(child) = self.child.take() {
            debug!("[BackendRuntime] 清理旧 Backend 句柄");
            let _ = child.kill().await;
        }

        let generation = self.health.begin_start();
        let on_message_for_generation: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |msg| {
            on_message(generation, msg);
        });

        // Debug builds use source Python by default, but CI/release smoke tests
        // can force the packaged sidecar to avoid hiding release-only defects.
        let force_sidecar = std::env::var("TAURI_PYTHON_BACKEND_MODE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("sidecar"));
        let result = if cfg!(debug_assertions) && !force_sidecar {
            info!("[BackendRuntime] 检测到开发模式，优先使用本地虚拟环境 Python 拉起脚本");
            self.start_dev_process(generation, on_message_for_generation, on_exit)
                .await
        } else {
            info!("[BackendRuntime] 检测到发布模式，拉起打包的 Backend 二进制程序");
            self.start_release_backend(generation, on_message_for_generation, on_exit)
                .await
        };

        if let Err(error) = &result {
            self.health.fail_current(generation, error.to_string());
            emit_backend_log(
                &self.app,
                &self.logs,
                &self.next_log_seq,
                "host",
                "process",
                error.to_string(),
            );
        }
        result
    }

    /// 停止正在运行的 Python Backend 进程。
    ///
    /// Fix 1+2：同步广播 ready=false 并清空 stdin_tx，让所有等待者和写入者立即感知停止。
    pub async fn stop(&mut self) -> Result<()> {
        info!("[BackendRuntime] stopping backend process");
        let generation = self.health.begin_stop();
        // 清空写入通道，writer 任务因 rx 关闭而自动退出（Fix 2）
        if let Ok(mut g) = self.stdin_tx.lock() {
            *g = None;
        }
        // Invalidate exit callbacks before killing so an old process cannot mark
        // a subsequently restarted generation as stopped.
        self.health.mark_stopped(generation, None);
        if let Some(child) = self.child.take() {
            info!("[BackendRuntime] sending backend kill signal");
            if let Err(error) = child.kill().await {
                self.health.fail_current(generation, error.to_string());
                return Err(error);
            }
            info!("[BackendRuntime] Backend 进程已被成功关闭");
        }
        Ok(())
    }

    pub fn log_snapshot(&self) -> Vec<BackendLogPayload> {
        self.logs
            .lock()
            .map(|buffer| buffer.iter().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(windows)]
fn force_kill_pid(pid: u32) -> Result<()> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow::anyhow!("taskkill failed for backend pid {pid}"))
    }
}

#[cfg(not(windows))]
fn force_kill_pid(pid: u32) -> Result<()> {
    // Kill direct children first (PyInstaller onefile worker), then the parent.
    let _ = std::process::Command::new("pkill")
        .args(["-KILL", "-P", &pid.to_string()])
        .status();
    let status = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(anyhow::anyhow!("kill failed for backend pid {pid}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_handshake_and_ignores_stale_generation() {
        let health = BackendHealth::new();
        let first = health.begin_start();
        assert!(!health.snapshot().ready);
        assert!(health.mark_ready(
            first,
            &serde_json::json!({"version": "1", "capabilities": ["echo"]}),
        ));
        assert!(health.snapshot().ready);

        health.mark_stopped(first, None);
        let second = health.begin_start();
        assert!(!health.mark_ready(
            first,
            &serde_json::json!({"version": "stale", "capabilities": []}),
        ));
        assert_eq!(health.snapshot().generation, second);
        assert!(!health.snapshot().ready);
    }

    #[test]
    fn oversized_unterminated_output_is_bounded() {
        let mut buffer = Vec::new();
        let lines = take_complete_lines(&mut buffer, b"0123456789", 4);
        assert!(lines.is_empty());
        assert!(buffer.is_empty());
    }
}
