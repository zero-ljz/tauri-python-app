use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::Mutex;

use crate::{event_bridge::EventBridge, rpc_client::RpcClient};

pub struct SidecarManager {
    app: AppHandle,
    client: Mutex<Option<RpcClient>>,
}

impl SidecarManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            client: Mutex::new(None),
        }
    }

    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        self.ensure_client().await?.request(method, params).await
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        self.ensure_client().await?.notify(method, params).await
    }

    async fn ensure_client(&self) -> Result<RpcClient, String> {
        let mut client = self.client.lock().await;
        if let Some(client) = client.as_ref() {
            if client.is_alive() {
                return Ok(client.clone());
            }
        }

        let spawned = self.spawn_sidecar()?;
        *client = Some(spawned.clone());
        Ok(spawned)
    }

    fn spawn_sidecar(&self) -> Result<RpcClient, String> {
        let bridge = EventBridge::new(self.app.clone());
        let backend_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("backend");

        let command = if let Ok(binary) = std::env::var("PYTHON_SIDECAR_BIN") {
            self.app.shell().command(binary)
        } else {
            let python =
                std::env::var("PYTHON_SIDECAR_PYTHON").unwrap_or_else(|_| "python".to_string());
            self.app
                .shell()
                .command(python)
                .args(["-m", "sidecar"])
                .current_dir(backend_dir)
                .env("PYTHONUNBUFFERED", "1")
        };

        let (mut rx, child) = command
            .spawn()
            .map_err(|error| format!("failed to spawn Python sidecar: {error}"))?;
        let pid = child.pid();
        let client = RpcClient::new(child);
        let reader_client = client.clone();
        bridge.emit_lifecycle("started", json!({ "pid": pid }));

        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        reader_client.handle_stdout_line(line, &bridge).await;
                    }
                    CommandEvent::Stderr(line) => {
                        bridge.emit_log(
                            "stderr",
                            String::from_utf8_lossy(&line).trim().to_string(),
                        );
                    }
                    CommandEvent::Error(error) => {
                        bridge.emit_lifecycle("io-error", json!({ "error": error }));
                    }
                    CommandEvent::Terminated(payload) => {
                        bridge.emit_lifecycle(
                            "terminated",
                            json!({
                                "code": payload.code,
                                "signal": payload.signal,
                            }),
                        );
                        reader_client.mark_terminated();
                        reader_client
                            .fail_all_pending("Python sidecar terminated")
                            .await;
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(client)
    }
}

#[tauri::command]
pub async fn sidecar_call(
    manager: State<'_, SidecarManager>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    manager.request(&method, params).await
}

#[tauri::command]
pub async fn sidecar_notify(
    manager: State<'_, SidecarManager>,
    method: String,
    params: Option<Value>,
) -> Result<(), String> {
    manager.notify(&method, params).await
}

#[tauri::command]
pub async fn sidecar_ping(manager: State<'_, SidecarManager>) -> Result<Value, String> {
    manager.request("system.ping", None).await
}

#[tauri::command]
pub async fn sidecar_task_catalog(manager: State<'_, SidecarManager>) -> Result<Value, String> {
    manager.request("task.catalog", None).await
}

#[tauri::command]
pub async fn sidecar_start_task(
    manager: State<'_, SidecarManager>,
    task_name: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    manager
        .request(
            "task.start",
            Some(json!({
                "task_name": task_name,
                "payload": payload.unwrap_or_else(|| json!({})),
            })),
        )
        .await
}

#[tauri::command]
pub async fn sidecar_cancel_task(
    manager: State<'_, SidecarManager>,
    task_id: String,
) -> Result<Value, String> {
    manager
        .request("task.cancel", Some(json!({ "task_id": task_id })))
        .await
}

#[tauri::command]
pub async fn sidecar_task_status(
    manager: State<'_, SidecarManager>,
    task_id: String,
) -> Result<Value, String> {
    manager
        .request("task.status", Some(json!({ "task_id": task_id })))
        .await
}
