use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri::AppHandle;
use serde_json::Value;
use anyhow::Result;
use log::{info, warn, error, debug};

use tokio::process::Command;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
                child.write(bytes).map_err(|e| anyhow::anyhow!("Sidecar stdin 写入失败: {}", e))?;
            }
            ActiveProcess::Dev { stdin, .. } => {
                stdin.write_all(bytes).await.map_err(|e| anyhow::anyhow!("Dev stdin 写入失败: {}", e))?;
                stdin.flush().await.map_err(|e| anyhow::anyhow!("Dev stdin 刷新失败: {}", e))?;
            }
        }
        Ok(())
    }

    /// 统一抽象安全终止进程的方法
    pub fn kill(self) -> Result<()> {
        match self {
            ActiveProcess::Sidecar(child) => {
                child.kill().map_err(|e| anyhow::anyhow!("终止 Sidecar 失败: {}", e))?;
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
}

impl SidecarManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            child: None,
            app,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn notify_exit(
        running: &Arc<AtomicBool>,
        on_exit: &Arc<dyn Fn() + Send + Sync>,
    ) {
        if running.swap(false, Ordering::SeqCst) {
            on_exit();
        }
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
            // ─── 开发调试模式：秒级直连 python ───
            info!("[SidecarManager] 检测到开发模式，使用系统 python 解释器秒级拉起脚本");
            
            let sidecar_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("sidecar")
                .join("main.py");
            let python = std::env::var("PYTHON").unwrap_or_else(|_| "python".to_string());

            let mut cmd = Command::new(python);
            cmd.arg(&sidecar_script)
               .stdin(Stdio::piped())
               .stdout(Stdio::piped())
               .stderr(Stdio::piped());
            
            let mut child = cmd.spawn().map_err(|e| anyhow::anyhow!("无法拉起 Python 调试进程，请检查环境变量: {}", e))?;
            let stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("无法获取 Python stdin 管道"))?;
            let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("无法获取 Python stdout 管道"))?;
            let stderr = child.stderr.take().ok_or_else(|| anyhow::anyhow!("无法获取 Python stderr 管道"))?;

            self.child = Some(ActiveProcess::Dev { child: Box::new(child), stdin });
            self.running.store(true, Ordering::SeqCst);

            // 异步监听 stdout
            let running = Arc::clone(&self.running);
            let on_exit = Arc::clone(&on_exit);
            let on_message = Arc::clone(&on_message);
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    debug!("[sidecar stdout (dev)] {}", line);
                    match serde_json::from_str::<Value>(&line) {
                        Ok(msg) => (on_message)(msg),
                        Err(e) => warn!("[SidecarManager] JSON 解析失败: {} — 原始数据: {}", e, line),
                    }
                }
                info!("[SidecarManager] 开发模式 stdout 管道已关闭");
                Self::notify_exit(&running, &on_exit);
            });

            // 异步监听 stderr 并直接打印日志
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    info!("[sidecar stderr (dev)] {}", line);
                }
            });

        } else {
            // ─── 生产发布模式：拉起编译打包好的 Sidecar 二进制 ───
            info!("[SidecarManager] 检测到发布模式，拉起打包的 Sidecar 二进制程序");
            
            let shell = self.app.shell();
            let (mut rx, child) = shell
                .sidecar("sidecar")
                .map_err(|e| anyhow::anyhow!("创建 Sidecar 实例失败: {}", e))?
                .spawn()
                .map_err(|e| anyhow::anyhow!("启动 Sidecar 进程失败: {}", e))?;

            self.child = Some(ActiveProcess::Sidecar(child));
            self.running.store(true, Ordering::SeqCst);

            let running = Arc::clone(&self.running);
            let on_exit = Arc::clone(&on_exit);
            let on_message = Arc::clone(&on_message);
            tokio::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            debug!("[sidecar stdout] {}", text);
                            match serde_json::from_str::<Value>(&text) {
                                Ok(msg) => (on_message)(msg),
                                Err(e) => warn!("[SidecarManager] JSON 解析失败: {} — 原始数据: {}", e, text),
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            let text = String::from_utf8_lossy(&line);
                            info!("[sidecar stderr] {}", text);
                        }
                        CommandEvent::Error(e) => {
                            error!("[SidecarManager] 进程管道错误: {}", e);
                        }
                        CommandEvent::Terminated(status) => {
                            info!("[SidecarManager] Sidecar 进程已退出: {:?}", status);
                            Self::notify_exit(&running, &on_exit);
                            break;
                        }
                        _ => {}
                    }
                }
                Self::notify_exit(&running, &on_exit);
            });
        }

        Ok(())
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
