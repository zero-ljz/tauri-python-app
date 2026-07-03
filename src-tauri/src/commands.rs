use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::backend::{BackendLogPayload, BackendRuntime};
use crate::rpc::RpcClient;

pub struct AppState {
    pub backend: Arc<Mutex<BackendRuntime>>,
    pub rpc: Arc<RpcClient>,
}

#[command]
pub async fn backend_status(state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    let backend = state.backend.lock().await;
    Ok(backend.is_running())
}

#[command]
pub async fn backend_logs(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<BackendLogPayload>, String> {
    let backend = state.backend.lock().await;
    Ok(backend.log_snapshot())
}

#[command]
pub async fn backend_stop(state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<(), String> {
    let mut backend = state.backend.lock().await;
    backend.stop().map_err(|e| e.to_string())?;
    state.rpc.mark_unready("Backend process was stopped manually");
    let _ = app.emit(
        "backend://backend.exited",
        serde_json::json!({ "reason": "manual stop" }),
    );
    Ok(())
}

#[command]
pub async fn backend_request(
    method: String,
    params: Option<Value>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    state
        .rpc
        .request(&method, params)
        .await
        .map_err(|e| e.to_string())
}

#[command]
pub async fn backend_notify(
    method: String,
    params: Option<Value>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state
        .rpc
        .notify(&method, params)
        .await
        .map_err(|e| e.to_string())
}
