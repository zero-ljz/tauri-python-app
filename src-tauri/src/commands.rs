use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{command, AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::backend::{BackendHealth, BackendLogPayload, BackendRuntime, BackendStatusPayload};
use crate::bridge::EventBridge;
use crate::events::backend_event_name;
use crate::rpc::{RpcClient, RpcFailure};

const DEFAULT_RPC_TIMEOUT_MS: u64 = 30_000;
const MAX_RPC_TIMEOUT_MS: u64 = 300_000;

pub struct AppState {
    pub backend: Arc<Mutex<BackendRuntime>>,
    pub rpc: Arc<RpcClient>,
    pub bridge: Arc<EventBridge>,
    pub health: Arc<BackendHealth>,
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
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }

    pub async fn start_backend(&self, app: AppHandle) -> Result<(), String> {
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

        let result = self
            .backend
            .lock()
            .await
            .start(on_message, on_exit)
            .await
            .map_err(|error| error.to_string());

        if let Err(reason) = &result {
            self.rpc.mark_unready(reason.clone());
            let _ = app.emit(
                &backend_event_name("backend.exited"),
                serde_json::json!({ "reason": reason, "recoverable": true }),
            );
        }
        result
    }

    pub async fn stop_backend(&self, reason: &str) -> Result<(), String> {
        self.rpc.mark_unready(reason.to_string());
        self.backend
            .lock()
            .await
            .stop()
            .await
            .map_err(|error| error.to_string())
    }
}

fn rpc_deadline(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_RPC_TIMEOUT_MS)
            .clamp(100, MAX_RPC_TIMEOUT_MS),
    )
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
    state
        .stop_backend("Backend process was stopped manually")
        .await?;
    let _ = app.emit(
        &backend_event_name("backend.exited"),
        serde_json::json!({ "reason": "manual stop", "recoverable": false }),
    );
    Ok(())
}

#[command]
pub async fn backend_restart(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    state.stop_backend("Backend process is restarting").await?;
    let _ = app.emit(
        &backend_event_name("backend.exited"),
        serde_json::json!({ "reason": "restarting", "recoverable": false }),
    );
    state.start_backend(app).await
}

#[command]
pub async fn backend_request(
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, RpcFailure> {
    state
        .rpc
        .request(&method, params, rpc_deadline(timeout_ms))
        .await
}

#[command]
pub async fn backend_notify(
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), RpcFailure> {
    state
        .rpc
        .notify(&method, params, rpc_deadline(timeout_ms))
        .await
}
