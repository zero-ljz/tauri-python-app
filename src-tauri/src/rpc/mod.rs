use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use dashmap::DashMap;
use serde_json::Value;
use uuid::Uuid;
use anyhow::Result;

use crate::sidecar::SidecarManager;

pub type RequestId = String;

/// 挂起的 RPC 请求记录：持有一个用于完成 Future 的 oneshot 发送端
struct PendingRequest {
    tx: oneshot::Sender<Result<Value>>,
}

/// JSON-RPC 2.0 客户端：通过 SidecarManager 将请求发送给 Python Sidecar 并接收结果
pub struct RpcClient {
    pending: Arc<DashMap<RequestId, PendingRequest>>,
    sidecar: Arc<Mutex<SidecarManager>>,
}

impl RpcClient {
    pub fn new(sidecar: Arc<Mutex<SidecarManager>>) -> Self {
        Self {
            pending: Arc::new(DashMap::new()),
            sidecar,
        }
    }

    /// 发送一个 JSON-RPC 2.0 请求并等待响应（带 30 秒超时控制）
    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params.unwrap_or(Value::Null),
        });

        let (tx, rx) = oneshot::channel();
        self.pending.insert(id.clone(), PendingRequest { tx });

        // 将请求消息通过 Sidecar 的标准输入发送出去
        {
            let mut sidecar = self.sidecar.lock().await;
            sidecar.write_message(&message).await?;
        }

        // 挂起等待响应，设置 30 秒超时
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(anyhow::anyhow!("RPC 通道意外关闭")),
            Err(_) => {
                self.pending.remove(&id);
                Err(anyhow::anyhow!("RPC 请求响应超时: {}", method))
            }
        }
    }

    /// 发送一个 JSON-RPC 2.0 通知（不需要等待任何响应）
    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<()> {
        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params.unwrap_or(Value::Null),
        });
        let mut sidecar = self.sidecar.lock().await;
        sidecar.write_message(&message).await
    }

    /// 当接收到来自 Python 的 RPC 响应时，通过消息 ID 匹配来唤醒对应的 oneshot 接收端
    pub fn resolve_response(&self, id: &str, result: Result<Value>) {
        if let Some((_, pending)) = self.pending.remove(id) {
            let _ = pending.tx.send(result);
        }
    }
}
