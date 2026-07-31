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
        pid: u32,
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
            ActiveProcess::Dev { mut child, pid } => {
                force_kill_pid(pid)
                    .map_err(|error| anyhow::anyhow!("终止开发 Backend 进程树失败: {error}"))?;
                let _ = child.wait().await;
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
    use std::collections::HashSet;

    let mut pending = vec![pid];
    let mut descendants = Vec::new();
    let mut seen = HashSet::new();
    while let Some(parent) = pending.pop() {
        if !seen.insert(parent) {
            continue;
        }
        descendants.push(parent);
        let output = std::process::Command::new("pgrep")
            .args(["-P", &parent.to_string()])
            .output();
        if let Ok(output) = output {
            pending.extend(parse_child_pids(&output.stdout));
        }
    }

    let mut root_killed = false;
    for target in descendants.into_iter().rev() {
        let status = std::process::Command::new("kill")
            .args(["-KILL", &target.to_string()])
            .status();
        if target == pid {
            root_killed = status.is_ok_and(|status| status.success());
        }
    }
    if root_killed {
        Ok(())
    } else {
        Err(anyhow::anyhow!("kill failed for backend pid {pid}"))
    }
}

#[cfg(not(windows))]
fn parse_child_pids(output: &[u8]) -> Vec<u32> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::parse_child_pids;

    #[test]
    fn child_pid_output_is_parsed_defensively() {
        assert_eq!(parse_child_pids(b"12\ninvalid\n34\n"), vec![12, 34]);
    }
}
