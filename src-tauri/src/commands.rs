use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{command, AppHandle, Emitter, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::Mutex;

use crate::backend::{BackendHealth, BackendLogPayload, BackendRuntime, BackendStatusPayload};
use crate::bridge::EventBridge;
use crate::events::backend_event_name;
use crate::protocol_config::PROTOCOL_VERSION;
use crate::rpc::{RpcClient, RpcFailure};

const DEFAULT_RPC_TIMEOUT_MS: u64 = 30_000;
const MAX_RPC_TIMEOUT_MS: u64 = 300_000;
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const PROCESS_EXIT_GRACE: Duration = Duration::from_secs(2);

pub struct AppState {
    pub backend: Arc<Mutex<BackendRuntime>>,
    pub rpc: Arc<RpcClient>,
    pub bridge: Arc<EventBridge>,
    pub health: Arc<BackendHealth>,
    lifecycle: Mutex<()>,
    shutting_down: AtomicBool,
}

impl AppState {
    pub fn new(
        backend: Arc<Mutex<BackendRuntime>>,
        rpc: Arc<RpcClient>,
        bridge: Arc<EventBridge>,
        health: Arc<BackendHealth>,
    ) -> Self {
        Self {
            backend,
            rpc,
            bridge,
            health,
            lifecycle: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }

    pub async fn start_backend(&self, app: AppHandle) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.start_backend_inner(app).await
    }

    async fn start_backend_inner(&self, app: AppHandle) -> Result<(), String> {
        if self.health.snapshot().running {
            return Ok(());
        }

        let bridge = Arc::clone(&self.bridge);
        let on_message: Arc<dyn Fn(u64, Value) + Send + Sync> =
            Arc::new(move |generation, message| bridge.handle_message(generation, message));

        let rpc_on_exit = Arc::clone(&self.rpc);
        let app_on_exit = app.clone();
        let on_exit: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            rpc_on_exit.mark_unready("Backend process exited");
            let _ = app_on_exit.emit(
                &backend_event_name("backend.exited"),
                serde_json::json!({ "reason": "process exited", "recoverable": true }),
            );
        });

        let start_result = self
            .backend
            .lock()
            .await
            .start(on_message, on_exit)
            .await
            .map_err(|error| error.to_string());
        let generation = match start_result {
            Ok(generation) => generation,
            Err(reason) => {
                self.rpc.mark_unready(reason.clone());
                let _ = app.emit(
                    &backend_event_name("backend.exited"),
                    serde_json::json!({ "reason": reason, "recoverable": true }),
                );
                return Err(reason);
            }
        };

        let result = async {
            let initialized = self
                .rpc
                .request_before_ready(
                    "initialize",
                    Some(serde_json::json!({
                        "protocol_version": PROTOCOL_VERSION,
                        "client": {
                            "name": env!("CARGO_PKG_NAME"),
                            "version": env!("CARGO_PKG_VERSION"),
                        },
                        "capabilities": {},
                    })),
                    INITIALIZE_TIMEOUT,
                )
                .await
                .map_err(|error| error.to_string())?;

            let protocol_version = initialized
                .get("protocol_version")
                .and_then(Value::as_str)
                .ok_or_else(|| "initialize 响应缺少 protocol_version".to_string())?;
            if protocol_version != PROTOCOL_VERSION {
                return Err(format!(
                    "Backend 协议版本不兼容: host={}, backend={protocol_version}",
                    PROTOCOL_VERSION
                ));
            }

            self.rpc
                .notify_before_ready("initialized", None, INITIALIZE_TIMEOUT)
                .await
                .map_err(|error| error.to_string())?;

            let ready_payload = serde_json::json!({
                "protocol_version": protocol_version,
                "version": initialized
                    .pointer("/server/version")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                "capabilities": initialized
                    .pointer("/capabilities/methods")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
                "method_permissions": initialized
                    .pointer("/capabilities/method_specs")
                    .and_then(Value::as_array)
                    .map(|specs| {
                        specs
                            .iter()
                            .filter_map(|spec| {
                                Some((
                                    spec.get("name")?.as_str()?.to_string(),
                                    Value::String(spec.get("permission")?.as_str()?.to_string()),
                                ))
                            })
                            .collect::<serde_json::Map<String, Value>>()
                    })
                    .unwrap_or_default(),
            });
            if !self.health.mark_ready(generation, &ready_payload) {
                return Err("Backend generation 在握手期间已失效".to_string());
            }
            app.emit(&backend_event_name("backend.ready"), ready_payload)
                .map_err(|error| format!("派发 backend.ready 失败: {error}"))?;
            Ok(())
        }
        .await;

        if let Err(reason) = &result {
            self.rpc.mark_unready(reason.clone());
            self.health.begin_stop();
            let _ = self
                .backend
                .lock()
                .await
                .stop(generation, Duration::ZERO)
                .await;
            self.health.fail_current(generation, reason.clone());
            let _ = app.emit(
                &backend_event_name("backend.exited"),
                serde_json::json!({ "reason": reason, "recoverable": true }),
            );
        }
        result
    }

    pub async fn stop_backend(&self, reason: &str) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_backend_inner(reason).await
    }

    async fn stop_backend_inner(&self, reason: &str) -> Result<(), String> {
        if !self.health.snapshot().running {
            self.rpc.mark_unready(reason.to_string());
            return Ok(());
        }

        let generation = self.health.begin_stop();
        let shutdown_result = self
            .rpc
            .request_before_ready("backend.shutdown", None, SHUTDOWN_TIMEOUT)
            .await;
        if let Err(error) = &shutdown_result {
            log::warn!("Backend graceful shutdown request failed: {error}");
        } else if let Err(error) = self
            .rpc
            .notify_before_ready("backend.exit", None, SHUTDOWN_TIMEOUT)
            .await
        {
            log::warn!("Backend exit notification failed: {error}");
        }

        self.rpc.mark_unready(reason.to_string());
        self.backend
            .lock()
            .await
            .stop(generation, PROCESS_EXIT_GRACE)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn stop_backend_manually(&self, app: AppHandle) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_backend_inner("Backend process was stopped manually")
            .await?;
        let _ = app.emit(
            &backend_event_name("backend.exited"),
            serde_json::json!({ "reason": "manual stop", "recoverable": false }),
        );
        Ok(())
    }

    pub async fn restart_backend(&self, app: AppHandle) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_backend_inner("Backend process is restarting")
            .await?;
        let _ = app.emit(
            &backend_event_name("backend.exited"),
            serde_json::json!({ "reason": "restarting", "recoverable": false }),
        );
        self.start_backend_inner(app).await
    }
}

fn rpc_deadline(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_RPC_TIMEOUT_MS)
            .clamp(100, MAX_RPC_TIMEOUT_MS),
    )
}

fn authorize_method(state: &AppState, method: &str, confirmed: bool) -> Result<(), RpcFailure> {
    let permission = state.health.method_permission(method);
    authorize_permission(permission.as_deref(), method, confirmed)
}

fn authorize_permission(
    permission: Option<&str>,
    method: &str,
    confirmed: bool,
) -> Result<(), RpcFailure> {
    match permission {
        None => Err(RpcFailure::new(
            -32601,
            format!("RPC method {method:?} is not advertised"),
        )),
        Some("public") => Ok(()),
        Some("debug-only") if cfg!(debug_assertions) => Ok(()),
        Some("debug-only") => Err(RpcFailure::new(
            -32010,
            format!("RPC method {method:?} is disabled in release builds"),
        )),
        Some("requires-confirmation") if confirmed => Ok(()),
        Some("requires-confirmation") => Err(RpcFailure::new(
            -32010,
            format!("RPC method {method:?} requires native user confirmation"),
        )),
        Some("dangerous") => Err(RpcFailure::new(
            -32010,
            format!(
                "RPC method {method:?} requires a dedicated Rust command and cannot use the generic bridge"
            ),
        )),
        Some(other) => Err(RpcFailure::new(
            -32010,
            format!("RPC method {method:?} has unsupported permission {other:?}"),
        )),
    }
}

async fn request_confirmation(app: &AppHandle, method: &str) -> Result<bool, RpcFailure> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "The application is requesting permission to run the sensitive operation:\n\n{method}"
        ))
        .title("Confirm sensitive operation")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |approved| {
            let _ = sender.send(approved);
        });
    receiver
        .await
        .map_err(|_| RpcFailure::new(-32010, "Native confirmation dialog closed unexpectedly"))
}

#[command]
pub async fn backend_status(
    state: State<'_, Arc<AppState>>,
) -> Result<BackendStatusPayload, String> {
    Ok(state.health.snapshot())
}

#[command]
pub async fn backend_logs(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<BackendLogPayload>, String> {
    Ok(state.backend.lock().await.log_snapshot())
}

#[command]
pub async fn backend_start(state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<(), String> {
    state.start_backend(app).await
}

#[command]
pub async fn backend_stop(state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<(), String> {
    state.stop_backend_manually(app).await
}

#[command]
pub async fn backend_restart(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    state.restart_backend(app).await
}

#[command]
pub async fn backend_request(
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
    correlation_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, RpcFailure> {
    authorize_method(&state, &method, false)?;
    state
        .rpc
        .request_with_correlation(&method, params, rpc_deadline(timeout_ms), correlation_id)
        .await
}

#[command]
pub async fn backend_request_confirmed(
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
    correlation_id: Option<String>,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<Value, RpcFailure> {
    authorize_method(&state, &method, true)?;
    if state.health.method_permission(&method).as_deref() == Some("requires-confirmation")
        && !request_confirmation(&app, &method).await?
    {
        return Err(RpcFailure::new(-32011, "Operation cancelled by user"));
    }
    state
        .rpc
        .request_with_correlation(&method, params, rpc_deadline(timeout_ms), correlation_id)
        .await
}

#[command]
pub async fn backend_notify(
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), RpcFailure> {
    authorize_method(&state, &method, false)?;
    state
        .rpc
        .notify(&method, params, rpc_deadline(timeout_ms))
        .await
}

#[cfg(test)]
mod authorization_tests {
    use super::*;

    #[test]
    fn generic_bridge_permission_matrix_is_explicit() {
        assert!(authorize_permission(Some("public"), "echo", false).is_ok());
        assert!(authorize_permission(Some("requires-confirmation"), "write", false).is_err());
        assert!(authorize_permission(Some("requires-confirmation"), "write", true).is_ok());
        assert!(authorize_permission(Some("dangerous"), "erase", true).is_err());
        assert!(authorize_permission(None, "missing", false).is_err());
    }
}
