use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use tauri::{command, AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::rpc::RpcClient;
use crate::sidecar::{SidecarLogPayload, SidecarManager};

/// 注入 Tauri 托管状态的全局应用共享状态结构体
pub struct AppState {
    pub sidecar: Arc<Mutex<SidecarManager>>,
    pub rpc: Arc<RpcClient>,
}

// ─── Sidecar 状态指令 ───────────────────────────────────────────────────────

#[command]
pub async fn sidecar_status(state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    let sidecar = state.sidecar.lock().await;
    Ok(sidecar.is_running())
}

#[command]
pub async fn sidecar_logs(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<SidecarLogPayload>, String> {
    let sidecar = state.sidecar.lock().await;
    Ok(sidecar.log_snapshot())
}

#[command]
pub async fn sidecar_stop(state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<(), String> {
    let mut sidecar = state.sidecar.lock().await;
    sidecar.stop().map_err(|e| e.to_string())?;
    state.rpc.mark_unready("Sidecar 进程已手动停止");
    let _ = app.emit(
        "sidecar://sidecar.exited",
        serde_json::json!({ "reason": "manual stop" }),
    );
    Ok(())
}

// ─── RPC 转发命令代理 ────────────────────────────────────────────────────────

/// 核心代理方法：前端发起 RPC 调用，经由 Rust 包装转发给 Python，并最终等待 Python 响应返回
#[command]
pub async fn rpc_request(
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

/// 前端向 Python 发送单向通知（不需等待结果）
#[command]
pub async fn rpc_notify(
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
