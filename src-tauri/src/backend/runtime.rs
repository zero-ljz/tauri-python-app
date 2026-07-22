use anyhow::Result;
use log::{debug, error, info, warn};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{atomic::AtomicU64, Arc, Mutex};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use super::health::BackendHealth;
use super::logs::{emit_backend_log, new_log_buffer, BackendLogBuffer, BackendLogPayload};
use super::process::{venv_python_path, ActiveProcess};
use super::transport::{
    handle_stdout_line, NdjsonDecoder, StdinMessage, StdinTx, MAX_LOG_LINE_BYTES,
    MAX_PROTOCOL_LINE_BYTES,
};

/// Supervises the Python process and owns its stdio transport endpoints.
pub struct BackendRuntime {
    child: Option<ActiveProcess>,
    app: AppHandle,
    health: Arc<BackendHealth>,
    logs: BackendLogBuffer,
    next_log_seq: Arc<AtomicU64>,
    stdin_tx: StdinTx,
}

impl BackendRuntime {
    pub fn new(app: AppHandle, health: Arc<BackendHealth>) -> Self {
        Self {
            child: None,
            app,
            health,
            logs: new_log_buffer(),
            next_log_seq: Arc::new(AtomicU64::new(0)),
            stdin_tx: Arc::new(Mutex::new(None)),
        }
    }

    pub fn ready_watch(&self) -> watch::Receiver<bool> {
        self.health.subscribe_ready()
    }

    pub fn stdin_sender(&self) -> StdinTx {
        Arc::clone(&self.stdin_tx)
    }

    fn notify_exit(
        health: &Arc<BackendHealth>,
        generation: u64,
        stdin_tx: &StdinTx,
        on_exit: &Arc<dyn Fn() + Send + Sync>,
    ) {
        let expected_exit = health.is_stopping_generation(generation);
        let reason = (!expected_exit).then(|| "Backend process exited".to_string());
        if health.mark_stopped(generation, reason) {
            if let Ok(mut sender) = stdin_tx.lock() {
                *sender = None;
            }
            if !expected_exit {
                on_exit();
            }
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

        let mut command = Command::new(&python);
        command
            .arg("-m")
            .arg("backend.main")
            .current_dir(&app_data_dir)
            .env("PYTHONPATH", workspace_dir)
            .env("TAURI_APP_DATA_DIR", &app_data_dir)
            .env("TAURI_APP_VERSION", env!("CARGO_PKG_VERSION"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|error| {
            anyhow::anyhow!(
                "无法拉起 Python 调试进程: python={}, module=backend.main, cwd={}, error={}",
                python.display(),
                app_data_dir.display(),
                error
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
        });

        let (sender, mut receiver) = mpsc::channel::<StdinMessage>(64);
        {
            let mut slot = self.stdin_tx.lock().expect("stdin sender lock poisoned");
            *slot = Some(sender);
        }

        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(message) = receiver.recv().await {
                let result = async {
                    stdin
                        .write_all(&message.bytes)
                        .await
                        .map_err(|error| error.to_string())?;
                    stdin.flush().await.map_err(|error| error.to_string())
                }
                .await;
                let failed = result.is_err();
                let _ = message.written.send(result);
                if failed {
                    warn!("[BackendRuntime] Dev stdin-writer: 写入失败，退出");
                    break;
                }
            }
            debug!("[BackendRuntime] Dev stdin-writer 任务已退出");
        });

        let stdout_health = Arc::clone(&self.health);
        let stdout_stdin_tx = Arc::clone(&self.stdin_tx);
        let stdout_on_exit = Arc::clone(&on_exit);
        let stdout_on_message = Arc::clone(&on_message);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut decoder = NdjsonDecoder::protocol(MAX_PROTOCOL_LINE_BYTES);
            let mut chunk = [0_u8; 8192];
            while let Ok(count) = reader.read(&mut chunk).await {
                if count == 0 {
                    break;
                }
                for line in decoder.push(&chunk[..count]) {
                    handle_stdout_line(&line, &stdout_on_message, "dev");
                }
            }
            if let Some(line) = decoder.finish() {
                handle_stdout_line(&line, &stdout_on_message, "dev");
            }
            info!("[BackendRuntime] 开发模式 stdout 管道已关闭");
            Self::notify_exit(
                &stdout_health,
                generation,
                &stdout_stdin_tx,
                &stdout_on_exit,
            );
        });

        let app = self.app.clone();
        let logs = Arc::clone(&self.logs);
        let next_log_seq = Arc::clone(&self.next_log_seq);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut decoder = NdjsonDecoder::logs(MAX_LOG_LINE_BYTES);
            let mut chunk = [0_u8; 8192];
            while let Ok(count) = reader.read(&mut chunk).await {
                if count == 0 {
                    break;
                }
                for line in decoder.push(&chunk[..count]) {
                    info!("[backend stderr (dev)] {}", line);
                    emit_backend_log(&app, &logs, &next_log_seq, "dev", "stderr", line);
                }
            }
            if let Some(line) = decoder.finish() {
                emit_backend_log(&app, &logs, &next_log_seq, "dev", "stderr", line);
            }
            info!("[BackendRuntime] 开发模式 stderr 管道已关闭");
        });

        Ok(())
    }

    async fn start_release_backend(
        &mut self,
        generation: u64,
        on_message: Arc<dyn Fn(Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let shell = self.app.shell();
        let app_data_dir = self.app_data_dir()?;
        let (mut events, child) = shell
            .sidecar("backend")
            .map_err(|error| anyhow::anyhow!("创建 Backend 实例失败: {}", error))?
            .current_dir(&app_data_dir)
            .env("TAURI_APP_DATA_DIR", &app_data_dir)
            .env("TAURI_APP_VERSION", env!("CARGO_PKG_VERSION"))
            .spawn()
            .map_err(|error| anyhow::anyhow!("启动 Backend 进程失败: {}", error))?;

        let child = Arc::new(Mutex::new(Some(child)));
        let writer_child = Arc::clone(&child);
        let (sender, mut receiver) = mpsc::channel::<StdinMessage>(64);
        {
            let mut slot = self.stdin_tx.lock().expect("stdin sender lock poisoned");
            *slot = Some(sender);
        }

        let pid = child
            .lock()
            .map_err(|_| anyhow::anyhow!("CommandChild 锁已中毒"))?
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Backend 进程句柄缺失"))?
            .pid();
        self.child = Some(ActiveProcess::Backend { child, pid });

        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                let StdinMessage { bytes, written } = message;
                let child = Arc::clone(&writer_child);
                let write_result = tokio::task::spawn_blocking(move || {
                    let mut slot = child
                        .lock()
                        .map_err(|_| anyhow::anyhow!("CommandChild 锁已中毒"))?;
                    let child = slot
                        .as_mut()
                        .ok_or_else(|| anyhow::anyhow!("Backend 进程句柄已释放"))?;
                    child.write(&bytes).map_err(anyhow::Error::from)
                })
                .await;
                let result = match write_result {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) => Err(error.to_string()),
                    Err(error) => Err(error.to_string()),
                };
                let failed = result.is_err();
                let _ = written.send(result);
                if failed {
                    warn!("[BackendRuntime] Backend stdin-writer: 写入失败，退出");
                    break;
                }
            }
            debug!("[BackendRuntime] Backend stdin-writer 任务已退出");
        });

        let health = Arc::clone(&self.health);
        let stdin_tx = Arc::clone(&self.stdin_tx);
        let app = self.app.clone();
        let logs = Arc::clone(&self.logs);
        let next_log_seq = Arc::clone(&self.next_log_seq);
        tokio::spawn(async move {
            let mut stdout_decoder = NdjsonDecoder::protocol(MAX_PROTOCOL_LINE_BYTES);
            let mut stderr_decoder = NdjsonDecoder::logs(MAX_LOG_LINE_BYTES);
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(chunk) => {
                        for line in stdout_decoder.push(&chunk) {
                            handle_stdout_line(&line, &on_message, "backend");
                        }
                    }
                    CommandEvent::Stderr(chunk) => {
                        for line in stderr_decoder.push(&chunk) {
                            info!("[backend stderr] {}", line);
                            emit_backend_log(&app, &logs, &next_log_seq, "backend", "stderr", line);
                        }
                    }
                    CommandEvent::Error(error) => {
                        error!("[BackendRuntime] 进程管道错误: {}", error);
                        emit_backend_log(
                            &app,
                            &logs,
                            &next_log_seq,
                            "backend",
                            "process",
                            error.to_string(),
                        );
                    }
                    CommandEvent::Terminated(status) => {
                        if let Some(line) = stdout_decoder.finish() {
                            handle_stdout_line(&line, &on_message, "backend");
                        }
                        if let Some(line) = stderr_decoder.finish() {
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
            Self::notify_exit(&health, generation, &stdin_tx, &on_exit);
        });

        Ok(())
    }

    pub async fn start(
        &mut self,
        on_message: Arc<dyn Fn(u64, Value) + Send + Sync>,
        on_exit: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<u64> {
        if self.health.is_running() {
            warn!("[BackendRuntime] Backend 进程已经在运行中");
            return Ok(self.health.current_generation());
        }

        if let Some(child) = self.child.take() {
            debug!("[BackendRuntime] 清理旧 Backend 句柄");
            let _ = child.kill().await;
        }

        let generation = self.health.begin_start();
        let generation_message: Arc<dyn Fn(Value) + Send + Sync> =
            Arc::new(move |message| on_message(generation, message));
        let force_sidecar = std::env::var("TAURI_PYTHON_BACKEND_MODE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("sidecar"));
        let result = if cfg!(debug_assertions) && !force_sidecar {
            info!("[BackendRuntime] 开发模式：启动本地 Python Backend");
            self.start_dev_process(generation, generation_message, on_exit)
                .await
        } else {
            info!("[BackendRuntime] 发布模式：启动打包 Backend sidecar");
            self.start_release_backend(generation, generation_message, on_exit)
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
        result.map(|_| generation)
    }

    pub async fn stop(&mut self, generation: u64, grace: std::time::Duration) -> Result<()> {
        info!("[BackendRuntime] stopping backend process");
        let exited_gracefully = tokio::time::timeout(grace, async {
            while self.health.is_generation_running(generation) {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await
        .is_ok();

        if let Ok(mut sender) = self.stdin_tx.lock() {
            *sender = None;
        }
        if let Some(child) = self.child.take() {
            if exited_gracefully {
                info!("[BackendRuntime] Backend exited gracefully");
            } else {
                info!("[BackendRuntime] graceful shutdown timed out; force killing backend");
                if let Err(error) = child.kill().await {
                    self.health.fail_current(generation, error.to_string());
                    return Err(error);
                }
            }
        }
        self.health.mark_stopped(generation, None);
        Ok(())
    }

    pub fn log_snapshot(&self) -> Vec<BackendLogPayload> {
        self.logs
            .lock()
            .map(|buffer| buffer.iter().cloned().collect())
            .unwrap_or_default()
    }
}
