use log::{debug, warn};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::backend::BackendHealth;
use crate::events::backend_event_name;
use crate::rpc::{RpcClient, RpcFailure};

/// 消息网桥：负责将来自 Python Backend 的各类响应与通知
/// 分发给 Rust 本地的 RpcClient 或者作为 Tauri 事件通知到前端。
pub struct EventBridge {
    app: AppHandle,
    rpc: Arc<RpcClient>,
    health: Arc<BackendHealth>,
}

impl EventBridge {
    pub fn new(app: AppHandle, rpc: Arc<RpcClient>, health: Arc<BackendHealth>) -> Self {
        Self { app, rpc, health }
    }

    fn response_id(msg: &Value) -> Option<String> {
        match msg.get("id") {
            Some(Value::String(id)) => Some(id.clone()),
            Some(Value::Number(id)) => Some(id.to_string()),
            _ => None,
        }
    }

    /// 接收从 Backend (stdout) 读取的每行 JSON 报文并进行解析和流向调度。
    pub fn handle_message(&self, generation: u64, msg: Value) {
        if !self.health.is_current_generation(generation) {
            warn!(
                "[EventBridge] 忽略旧 Backend generation={} 的消息",
                generation
            );
            return;
        }

        let jsonrpc = msg.get("jsonrpc").and_then(|v| v.as_str()).unwrap_or("");
        if jsonrpc != "2.0" {
            warn!("[EventBridge] 忽略非 JSON-RPC 格式的消息: {:?}", msg);
            return;
        }

        // 判定是否是带 ID 的响应报文 (Response)
        if let Some(id) = Self::response_id(&msg) {
            if let Some(error) = msg.get("error") {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
                let err_msg = error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知 RPC 响应内部错误");
                debug!("[EventBridge] 收到错误响应: id={}, message={}", id, err_msg);
                let failure = RpcFailure::new(code, err_msg).with_data(error.get("data").cloned());
                self.rpc.resolve_response(&id, Err(failure));
            } else if let Some(result) = msg.get("result") {
                debug!("[EventBridge] 收到正常响应: id={}, result={:?}", id, result);
                self.rpc.resolve_response(&id, Ok(result.clone()));
            } else {
                warn!("[EventBridge] 响应报文缺少 result/error 字段: {:?}", msg);
                self.rpc
                    .resolve_response(&id, Err(RpcFailure::new(-32600, "Backend 返回了无效响应")));
            }
            return;
        }

        // 如果不含 ID，说明这是单向通知 (Notification)
        if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            debug!("[EventBridge] 收到来自 Python 的通知: method={}", method);

            // 将后端通知转发为前端监听的 Tauri 事件。
            let event_name = backend_event_name(method);
            if let Err(e) = self.app.emit(&event_name, params) {
                warn!("[EventBridge] 派发事件失败 {}: {}", event_name, e);
            }
        }
    }
}
