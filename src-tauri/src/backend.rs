use anyhow::Result;
use log::{debug, error, info, warn};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

const MAX_BACKEND_LOGS: usize = 500;

/// stdin 消息发送端的共享类型别名。
/// - Option::None  → 进程未运行，写入会立即报错
/// - Option::Some  → 进程运行中，消息投入队列后由 writer 任务异步写入
pub type StdinTx = Arc<StdMutex<Option<mpsc::Sender<Vec<u8>>>>>;

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

    if let Err(e) = app.emit("backend://backend.log", payload) {
        warn!("[BackendRuntime] 转发 Backend 日志失败: {}", e);
    }
}

fn take_complete_lines(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
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
        if !line.is_empty() {
            lines.push(String::from_utf8_lossy(&line).to_string());
        }
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
    Backend(Arc<StdMutex<CommandChild>>),
    /// 本地开发模式：直连系统的 Python 解释器（stdin 已被 writer 任务独占消费）
    Dev {
        child: Box<tokio::process::Child>,
    },
}

impl ActiveProcess {
    /// 统一抽象安全终止进程的方法
    pub fn kill(self) -> Result<()> {
        match self {
            ActiveProcess::Backend(child_arc) => {
                // 取出 CommandChild 所有权（Mutex 消费）再 kill
                let child = Arc::try_unwrap(child_arc)
                    .map_err(|_| anyhow::anyhow!("CommandChild Arc 仍有其他持有者，无法 kill"))?
                    .into_inner()
                    .map_err(|_| anyhow::anyhow!("CommandChild Mutex 已中毒"))?;
                child
                    .kill()
                    .map_err(|e| anyhow::anyhow!("终止 Backend 失败: {}", e))?;
            }
            ActiveProcess::Dev { mut child } => {
                let _ = child.start_kill();
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
    running: Arc<AtomicBool>,
    /// 进程就绪广播发送端：发送 true = 就绪，false = 退出/停止。
    /// 包裹在 Arc 中以便背景任务持有引用。
    ready_tx: Arc<watch::Sender<bool>>,
    logs: BackendLogBuffer,
    next_log_seq: Arc<AtomicU64>,
    /// 独立 stdin 写入通道：与 BackendRuntime 锁解耦，RpcClient 可独立写入。
    stdin_tx: StdinTx,
}

impl BackendRuntime {
    pub fn new(app: AppHandle) -> Self {
        let (ready_tx, _initial_rx) = watch::channel(false);
        Self {
            child: None,
            app,
            running: Arc::new(AtomicBool::new(false)),
            ready_tx: Arc::new(ready_tx),
            logs: Arc::new(StdMutex::new(VecDeque::with_capacity(MAX_BACKEND_LOGS))),
            next_log_seq: Arc::new(AtomicU64::new(0)),
            stdin_tx: Arc::new(StdMutex::new(None)),
        }
    }

    /// 返回就绪状态 watch 订阅端，供 RpcClient 等外部组件监听进程启动/退出事件。
    /// 每次调用返回独立订阅端，多个 waiter 并发等待时全部同时唤醒（Fix 1 核心）。
    pub fn ready_watch(&self) -> watch::Receiver<bool> {
        self.ready_tx.subscribe()
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
        running: &Arc<AtomicBool>,
        ready_tx: &Arc<watch::Sender<bool>>,
        stdin_tx: &StdinTx,
        on_exit: &Arc<dyn Fn() + Send + Sync>,
    ) {
        if running.swap(false, Ordering::SeqCst) {
            let _ = ready_tx.send(false);
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

    /// 开发调试模式：直接调用本地 Python 解释器运行 backend 脚本。
    ///
    /// Fix 2：stdin 在此处被取出，交由独立的 writer 任务持有，不再存入 ActiveProcess。
    /// Fix 3：stdout 和 stderr 任务关闭时均触发 notify_exit（幂等），提高进程退出检测可靠性。
    async fn start_dev_process(
        &mut self,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_dir = manifest_dir.parent().unwrap_or(manifest_dir.as_path());
        let backend_dir = workspace_dir.join("backend");
        let backend_script = backend_dir.join("main.py");
        let python = Self::resolve_dev_python();
        info!("[BackendRuntime] 开发模式 Python: {}", python.display());

        let mut cmd = Command::new(&python);
        cmd.arg(&backend_script)
            .current_dir(&backend_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "无法拉起 Python 调试进程: python={}, script={}, error={}",
                python.display(),
                backend_script.display(),
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

        // 标记进程就绪，向所有 waiter 广播 true（Fix 1）
        self.running.store(true, Ordering::SeqCst);
        self.ready_tx.send(true).ok();

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
        let running_stdout = Arc::clone(&self.running);
        let ready_tx_stdout = Arc::clone(&self.ready_tx);
        let stdin_tx_stdout = Arc::clone(&self.stdin_tx);
        let on_exit_stdout = Arc::clone(&on_exit);
        let on_message_clone = Arc::clone(&on_message);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                handle_stdout_line(&line, &on_message_clone, "dev");
            }
            info!("[BackendRuntime] 开发模式 stdout 管道已关闭");
            Self::notify_exit(&running_stdout, &ready_tx_stdout, &stdin_tx_stdout, &on_exit_stdout);
        });

        // ── stderr reader 任务（Fix 3：关闭时也触发 notify_exit，幂等安全）────────────
        let app = self.app.clone();
        let logs = Arc::clone(&self.logs);
        let next_log_seq = Arc::clone(&self.next_log_seq);
        let running_stderr = Arc::clone(&self.running);
        let ready_tx_stderr = Arc::clone(&self.ready_tx);
        let stdin_tx_stderr = Arc::clone(&self.stdin_tx);
        let on_exit_stderr = Arc::clone(&on_exit);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!("[backend stderr (dev)] {}", line);
                emit_backend_log(&app, &logs, &next_log_seq, "dev", "stderr", line);
            }
            info!("[BackendRuntime] 开发模式 stderr 管道已关闭");
            // Fix 3：stderr 关闭也视为进程退出信号（幂等，只触发一次）
            Self::notify_exit(&running_stderr, &ready_tx_stderr, &stdin_tx_stderr, &on_exit_stderr);
        });

        Ok(())
    }

    /// 生产发布模式：拉起 PyInstaller 打包好的 Backend 二进制程序。
    ///
    /// Fix 2：CommandChild 用 Arc 包裹共享于 writer 任务和 kill 路径；
    ///         writer 任务独立写入，不再需要锁住 BackendRuntime。
    async fn start_release_backend(
        &mut self,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let shell = self.app.shell();
        let (mut rx, child) = shell
            .sidecar("backend")
            .map_err(|e| anyhow::anyhow!("创建 Backend 实例失败: {}", e))?
            .spawn()
            .map_err(|e| anyhow::anyhow!("启动 Backend 进程失败: {}", e))?;

        // CommandChild::write 取 &mut self，用 Arc<StdMutex<>> 共享给 writer 任务和 kill 路径
        let child_arc = Arc::new(StdMutex::new(child));
        let child_for_writer = Arc::clone(&child_arc);

        // 建立 stdin 写入 mpsc 通道
        let (tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);
        {
            let mut g = self.stdin_tx.lock().unwrap();
            *g = Some(tx);
        }

        self.child = Some(ActiveProcess::Backend(child_arc));
        self.running.store(true, Ordering::SeqCst);
        self.ready_tx.send(true).ok();

        // ── stdin writer 任务：锁 CommandChild，调用 write()（同步但通常极快）────────
        tokio::spawn(async move {
            while let Some(bytes) = stdin_rx.recv().await {
                match child_for_writer.lock() {
                    Ok(mut child) => {
                        if child.write(&bytes).is_err() {
                            warn!("[BackendRuntime] Backend stdin-writer: 写入失败，退出");
                            break;
                        }
                    }
                    Err(_) => {
                        warn!("[BackendRuntime] Backend stdin-writer: CommandChild 锁已中毒");
                        break;
                    }
                }
            }
            debug!("[BackendRuntime] Backend stdin-writer 任务已退出");
        });

        // ── 事件监听任务（stdout/stderr/exit）────────────────────────────────────────
        let running = Arc::clone(&self.running);
        let ready_tx = Arc::clone(&self.ready_tx);
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
                        for line in take_complete_lines(&mut stdout_buffer, &chunk) {
                            handle_stdout_line(&line, &on_message, "backend");
                        }
                    }
                    CommandEvent::Stderr(chunk) => {
                        for line in take_complete_lines(&mut stderr_buffer, &chunk) {
                            info!("[backend stderr] {}", line);
                            emit_backend_log(
                                &app,
                                &logs,
                                &next_log_seq,
                                "backend",
                                "stderr",
                                line,
                            );
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
                            emit_backend_log(
                                &app,
                                &logs,
                                &next_log_seq,
                                "backend",
                                "stderr",
                                line,
                            );
                        }
                        info!("[BackendRuntime] Backend 进程已退出: {:?}", status);
                        Self::notify_exit(&running, &ready_tx, &stdin_tx, &on_exit);
                        break;
                    }
                    _ => {}
                }
            }
            // 兜底：rx 通道异常关闭时也触发退出通知
            Self::notify_exit(&running, &ready_tx, &stdin_tx, &on_exit);
        });

        Ok(())
    }

    /// 启动 Python Backend 进程。
    pub async fn start(
        &mut self,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            warn!("[BackendRuntime] Backend 进程已经在运行中");
            return Ok(());
        }

        if self.child.take().is_some() {
            debug!("[BackendRuntime] 清理已退出的旧 Backend 句柄");
        }

        // 根据编译条件判定当前是开发模式还是打包发布模式
        if cfg!(debug_assertions) {
            info!("[BackendRuntime] 检测到开发模式，优先使用本地虚拟环境 Python 拉起脚本");
            self.start_dev_process(on_message, on_exit).await
        } else {
            info!("[BackendRuntime] 检测到发布模式，拉起打包的 Backend 二进制程序");
            self.start_release_backend(on_message, on_exit).await
        }
    }

    /// 停止正在运行的 Python Backend 进程。
    ///
    /// Fix 1+2：同步广播 ready=false 并清空 stdin_tx，让所有等待者和写入者立即感知停止。
    pub fn stop(&mut self) -> Result<()> {
        self.running.store(false, Ordering::SeqCst);
        // 广播进程不可用（Fix 1）
        let _ = self.ready_tx.send(false);
        // 清空写入通道，writer 任务因 rx 关闭而自动退出（Fix 2）
        if let Ok(mut g) = self.stdin_tx.lock() {
            *g = None;
        }
        if let Some(child) = self.child.take() {
            child.kill()?;
            info!("[BackendRuntime] Backend 进程已被成功关闭");
        }
        Ok(())
    }

    /// 查询当前运行状态
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn log_snapshot(&self) -> Vec<BackendLogPayload> {
        self.logs
            .lock()
            .map(|buffer| buffer.iter().cloned().collect())
            .unwrap_or_default()
    }
}
