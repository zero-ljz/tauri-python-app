use log::{debug, warn};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::rpc::RpcClient;

/// 消息网桥：负责将来自 Python Backend 的各类响应与通知
/// 分发给 Rust 本地的 RpcClient 或者作为 Tauri 事件通知到前端。
pub struct EventBridge {
    app: AppHandle,
    rpc: Arc<RpcClient>,
}

impl EventBridge {
    pub fn new(app: AppHandle, rpc: Arc<RpcClient>) -> Self {
        Self { app, rpc }
    }

    fn response_id(msg: &Value) -> Option<String> {
        match msg.get("id") {
            Some(Value::String(id)) => Some(id.clone()),
            Some(Value::Number(id)) => Some(id.to_string()),
            _ => None,
        }
    }

    /// 接收从 Backend (stdout) 读取的每行 JSON 报文并进行解析和流向调度。
    pub fn handle_message(&self, msg: Value) {
        let jsonrpc = msg.get("jsonrpc").and_then(|v| v.as_str()).unwrap_or("");
        if jsonrpc != "2.0" {
            warn!("[EventBridge] 忽略非 JSON-RPC 格式的消息: {:?}", msg);
            return;
        }

        // 判定是否是带 ID 的响应报文 (Response)
        if let Some(id) = Self::response_id(&msg) {
            if let Some(error) = msg.get("error") {
                let err_msg = error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未知 RPC 响应内部错误");
                debug!("[EventBridge] 收到错误响应: id={}, message={}", id, err_msg);
                self.rpc
                    .resolve_response(&id, Err(anyhow::anyhow!("{}", err_msg)));
            } else if let Some(result) = msg.get("result") {
                debug!("[EventBridge] 收到正常响应: id={}, result={:?}", id, result);
                self.rpc.resolve_response(&id, Ok(result.clone()));
            } else {
                warn!("[EventBridge] 响应报文缺少 result/error 字段: {:?}", msg);
            }
            return;
        }

        // 如果不含 ID，说明这是单向通知 (Notification)
        if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            debug!("[EventBridge] 收到来自 Python 的通知: method={}", method);

            // 将通知转换转发为 Tauri 的前端全局订阅事件
            let event_name = format!("backend://{}", method);
            if let Err(e) = self.app.emit(&event_name, params) {
                warn!("[EventBridge] 派发事件失败 {}: {}", event_name, e);
            }
        }
    }
}
