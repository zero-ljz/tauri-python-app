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
use tokio::sync::Notify;

const MAX_SIDECAR_LOGS: usize = 500;

#[derive(Clone, Serialize)]
pub struct SidecarLogPayload {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub level: &'static str,
    pub stream: &'static str,
    pub source: &'static str,
    pub message: String,
}

type SidecarLogBuffer = Arc<StdMutex<VecDeque<SidecarLogPayload>>>;

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

fn emit_sidecar_log(
    app: &AppHandle,
    logs: &SidecarLogBuffer,
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

    let payload = SidecarLogPayload {
        seq: next_log_seq.fetch_add(1, Ordering::SeqCst) + 1,
        timestamp_ms: now_ms(),
        level,
        stream,
        source,
        message,
    };

    if let Ok(mut buffer) = logs.lock() {
        buffer.push_back(payload.clone());
        while buffer.len() > MAX_SIDECAR_LOGS {
            buffer.pop_front();
        }
    } else {
        warn!("[SidecarManager] 写入 Sidecar 日志缓冲区失败");
    }

    if let Err(e) = app.emit("sidecar://sidecar.log", payload) {
        warn!("[SidecarManager] 转发 Sidecar 日志失败: {}", e);
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
    debug!("[sidecar stdout ({})] {}", source, line);
    match serde_json::from_str::<Value>(line) {
        Ok(msg) => (on_message)(msg),
        Err(e) => warn!("[SidecarManager] JSON 解析失败: {} — 原始数据: {}", e, line),
    }
}

/// 抽象表示当前运行中的 Sidecar 进程，支持开发模式直接执行和生产模式 Sidecar 二进制执行
pub enum ActiveProcess {
    /// 生产发布模式：Tauri 托管的二进制 Sidecar
    Sidecar(CommandChild),
    /// 本地开发模式：直连系统的 Python 解释器
    Dev {
        child: Box<tokio::process::Child>,
        stdin: tokio::process::ChildStdin,
    },
}

impl ActiveProcess {
    /// 统一抽象向标准输入流（stdin）写入字节的方法
    pub async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        match self {
            ActiveProcess::Sidecar(child) => {
                child
                    .write(bytes)
                    .map_err(|e| anyhow::anyhow!("Sidecar stdin 写入失败: {}", e))?;
            }
            ActiveProcess::Dev { stdin, .. } => {
                stdin
                    .write_all(bytes)
                    .await
                    .map_err(|e| anyhow::anyhow!("Dev stdin 写入失败: {}", e))?;
                stdin
                    .flush()
                    .await
                    .map_err(|e| anyhow::anyhow!("Dev stdin 刷新失败: {}", e))?;
            }
        }
        Ok(())
    }

    /// 统一抽象安全终止进程的方法
    pub fn kill(self) -> Result<()> {
        match self {
            ActiveProcess::Sidecar(child) => {
                child
                    .kill()
                    .map_err(|e| anyhow::anyhow!("终止 Sidecar 失败: {}", e))?;
            }
            ActiveProcess::Dev { mut child, .. } => {
                let _ = child.start_kill();
            }
        }
        Ok(())
    }
}

/// 负责管理 Python Sidecar 进程的生命周期。
pub struct SidecarManager {
    child: Option<ActiveProcess>,
    app: AppHandle,
    running: Arc<AtomicBool>,
    /// 进程就绪通知器：当进程成功启动并设置 running=true 后触发 notify_one()，
    /// 供 RpcClient 等外部组件精确唤醒，替代忙轮询。
    ready_notify: Arc<Notify>,
    logs: SidecarLogBuffer,
    next_log_seq: Arc<AtomicU64>,
}

impl SidecarManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            child: None,
            app,
            running: Arc::new(AtomicBool::new(false)),
            ready_notify: Arc::new(Notify::new()),
            logs: Arc::new(StdMutex::new(VecDeque::with_capacity(MAX_SIDECAR_LOGS))),
            next_log_seq: Arc::new(AtomicU64::new(0)),
        }
    }

    fn notify_exit(running: &Arc<AtomicBool>, on_exit: &Arc<dyn Fn() + Send + Sync>) {
        if running.swap(false, Ordering::SeqCst) {
            on_exit();
        }
    }

    /// 返回就绪通知器的共享引用，供 RpcClient 等外部组件监听进程启动事件。
    pub fn ready_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.ready_notify)
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

    /// 开发调试模式：直接调用本地 Python 解释器运行 sidecar 脚本。
    async fn start_dev_process(
        &mut self,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let sidecar_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar");
        let sidecar_script = sidecar_dir.join("main.py");
        let python = Self::resolve_dev_python();
        info!("[SidecarManager] 开发模式 Python: {}", python.display());

        let mut cmd = Command::new(&python);
        cmd.arg(&sidecar_script)
            .current_dir(&sidecar_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "无法拉起 Python 调试进程: python={}, script={}, error={}",
                python.display(),
                sidecar_script.display(),
                e
            )
        })?;
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

        self.child = Some(ActiveProcess::Dev {
            child: Box::new(child),
            stdin,
        });
        self.running.store(true, Ordering::SeqCst);
        // 通知等待方（如 RpcClient）：进程已就绪；notify_one 会存储 permit，
        // 即使此时尚无等待者，之后第一个 notified().await 也会立即返回。
        self.ready_notify.notify_one();

        // 异步监听 stdout
        let running = Arc::clone(&self.running);
        let on_exit_stdout = Arc::clone(&on_exit);
        let on_message_clone = Arc::clone(&on_message);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                handle_stdout_line(&line, &on_message_clone, "dev");
            }
            info!("[SidecarManager] 开发模式 stdout 管道已关闭");
            Self::notify_exit(&running, &on_exit_stdout);
        });

        // 异步监听 stderr 并直接打印日志
        let app = self.app.clone();
        let logs = Arc::clone(&self.logs);
        let next_log_seq = Arc::clone(&self.next_log_seq);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                info!("[sidecar stderr (dev)] {}", line);
                emit_sidecar_log(&app, &logs, &next_log_seq, "dev", "stderr", line);
            }
        });

        Ok(())
    }

    /// 生产发布模式：拉起 PyInstaller 打包好的 Sidecar 二进制程序。
    async fn start_release_sidecar(
        &mut self,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let shell = self.app.shell();
        let (mut rx, child) = shell
            .sidecar("sidecar")
            .map_err(|e| anyhow::anyhow!("创建 Sidecar 实例失败: {}", e))?
            .spawn()
            .map_err(|e| anyhow::anyhow!("启动 Sidecar 进程失败: {}", e))?;

        self.child = Some(ActiveProcess::Sidecar(child));
        self.running.store(true, Ordering::SeqCst);
        self.ready_notify.notify_one();

        let running = Arc::clone(&self.running);
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
                            handle_stdout_line(&line, &on_message, "sidecar");
                        }
                    }
                    CommandEvent::Stderr(chunk) => {
                        for line in take_complete_lines(&mut stderr_buffer, &chunk) {
                            info!("[sidecar stderr] {}", line);
                            emit_sidecar_log(
                                &app,
                                &logs,
                                &next_log_seq,
                                "sidecar",
                                "stderr",
                                line,
                            );
                        }
                    }
                    CommandEvent::Error(e) => {
                        error!("[SidecarManager] 进程管道错误: {}", e);
                        emit_sidecar_log(
                            &app,
                            &logs,
                            &next_log_seq,
                            "sidecar",
                            "process",
                            e.to_string(),
                        );
                    }
                    CommandEvent::Terminated(status) => {
                        if let Some(line) = take_remaining_line(&mut stdout_buffer) {
                            handle_stdout_line(&line, &on_message, "sidecar");
                        }
                        if let Some(line) = take_remaining_line(&mut stderr_buffer) {
                            info!("[sidecar stderr] {}", line);
                            emit_sidecar_log(
                                &app,
                                &logs,
                                &next_log_seq,
                                "sidecar",
                                "stderr",
                                line,
                            );
                        }
                        info!("[SidecarManager] Sidecar 进程已退出: {:?}", status);
                        Self::notify_exit(&running, &on_exit);
                        break;
                    }
                    _ => {}
                }
            }
            Self::notify_exit(&running, &on_exit);
        });

        Ok(())
    }

    /// 启动 Python Sidecar 进程。
    pub async fn start(
        &mut self,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        if self.running.load(Ordering::SeqCst) {
            warn!("[SidecarManager] Sidecar 进程已经在运行中");
            return Ok(());
        }

        if self.child.take().is_some() {
            debug!("[SidecarManager] 清理已退出的旧 Sidecar 句柄");
        }

        // 根据编译条件判定当前是开发模式还是打包发布模式
        if cfg!(debug_assertions) {
            info!("[SidecarManager] 检测到开发模式，优先使用本地虚拟环境 Python 拉起脚本");
            self.start_dev_process(on_message, on_exit).await
        } else {
            info!("[SidecarManager] 检测到发布模式，拉起打包的 Sidecar 二进制程序");
            self.start_release_sidecar(on_message, on_exit).await
        }
    }

    /// 停止正在运行的 Python Sidecar 进程。
    pub fn stop(&mut self) -> Result<()> {
        self.running.store(false, Ordering::SeqCst);
        if let Some(child) = self.child.take() {
            child.kill()?;
            info!("[SidecarManager] Sidecar 进程已被成功关闭");
        }
        Ok(())
    }

    // 查询当前运行状态
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn log_snapshot(&self) -> Vec<SidecarLogPayload> {
        self.logs
            .lock()
            .map(|buffer| buffer.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 向 Sidecar 的标准输入（stdin）写入一行 JSON 报文并换行。
    pub async fn write_message(&mut self, msg: &Value) -> Result<()> {
        if let Some(child) = &mut self.child {
            let mut line = serde_json::to_string(msg)?;
            line.push('\n');
            child.write(line.as_bytes()).await?;
            Ok(())
        } else {
            Err(anyhow::anyhow!("Sidecar 进程未处于运行状态"))
        }
    }
}
