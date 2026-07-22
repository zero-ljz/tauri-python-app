use anyhow::Result;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri_plugin_shell::process::CommandChild;

pub(super) enum ActiveProcess {
    Backend {
        child: Arc<Mutex<Option<CommandChild>>>,
        pid: u32,
    },
    Dev {
        child: Box<tokio::process::Child>,
    },
}

impl ActiveProcess {
    pub(super) async fn kill(self) -> Result<()> {
        match self {
            ActiveProcess::Backend { child, pid } => {
                // PyInstaller onefile uses a bootloader parent and Python child.
                force_kill_pid(pid)?;
                if let Ok(mut child_slot) = child.try_lock() {
                    child_slot.take();
                }
            }
            ActiveProcess::Dev { mut child } => {
                child
                    .kill()
                    .await
                    .map_err(|error| anyhow::anyhow!("终止开发 Backend 失败: {}", error))?;
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
pub(super) fn venv_python_path(venv_dir: PathBuf) -> PathBuf {
    venv_dir.join("Scripts").join("python.exe")
}

#[cfg(not(windows))]
pub(super) fn venv_python_path(venv_dir: PathBuf) -> PathBuf {
    venv_dir.join("bin").join("python")
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
