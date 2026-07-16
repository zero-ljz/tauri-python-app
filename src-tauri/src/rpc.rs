use dashmap::DashMap;
use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

use crate::backend::StdinTx;

pub type RequestId = String;
pub type RpcResult<T> = Result<T, RpcFailure>;

#[derive(Clone, Debug, Serialize)]
pub struct RpcFailure {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcFailure {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Option<Value>) -> Self {
        self.data = data;
        self
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(-32001, message)
    }

    fn timeout(method: &str) -> Self {
        Self::new(-32002, format!("RPC 请求超时: {method}"))
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(-32603, message)
    }
}

impl fmt::Display for RpcFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} (code {})", self.message, self.code)
    }
}

impl std::error::Error for RpcFailure {}

struct PendingRequest {
    tx: oneshot::Sender<RpcResult<Value>>,
}

/// JSON-RPC client over the backend stdin/stdout transport.
pub struct RpcClient {
    pending: Arc<DashMap<RequestId, PendingRequest>>,
    stdin_tx: StdinTx,
    ready_rx: watch::Receiver<bool>,
}

impl RpcClient {
    pub fn new(stdin_tx: StdinTx, ready_rx: watch::Receiver<bool>) -> Self {
        Self {
            pending: Arc::new(DashMap::new()),
            stdin_tx,
            ready_rx,
        }
    }

    pub fn mark_unready(&self, reason: impl Into<String>) {
        let reason = reason.into();
        let ids: Vec<RequestId> = self.pending.iter().map(|item| item.key().clone()).collect();
        for id in ids {
            if let Some((_, pending)) = self.pending.remove(&id) {
                let _ = pending
                    .tx
                    .send(Err(RpcFailure::unavailable(reason.clone())));
            }
        }

        if let Ok(mut sender) = self.stdin_tx.lock() {
            *sender = None;
        }
    }

    async fn wait_until_ready(&self) -> RpcResult<()> {
        if *self.ready_rx.borrow() {
            return Ok(());
        }

        let mut receiver = self.ready_rx.clone();
        receiver
            .wait_for(|ready| *ready)
            .await
            .map(|_| ())
            .map_err(|_| RpcFailure::unavailable("Backend 就绪通知通道已关闭"))
    }

    pub async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        deadline: Duration,
    ) -> RpcResult<Value> {
        let id = Uuid::new_v4().to_string();
        let request_id = id.clone();
        let operation = async {
            self.wait_until_ready().await?;

            let message = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params.unwrap_or(Value::Null),
            });
            let mut line = serde_json::to_vec(&message)
                .map_err(|error| RpcFailure::internal(format!("RPC 消息序列化失败: {error}")))?;
            line.push(b'\n');

            let (tx, rx) = oneshot::channel();
            self.pending
                .insert(request_id.clone(), PendingRequest { tx });

            let sender = {
                let guard = self
                    .stdin_tx
                    .lock()
                    .map_err(|_| RpcFailure::internal("stdin_tx 锁已中毒"))?;
                guard
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| RpcFailure::unavailable("Backend stdin 通道已关闭"))?
            };

            sender
                .send(line)
                .await
                .map_err(|_| RpcFailure::unavailable("Backend stdin 写入队列已关闭"))?;

            rx.await
                .map_err(|_| RpcFailure::unavailable("RPC 响应通道意外关闭"))?
        };

        let result = tokio::time::timeout(deadline, operation)
            .await
            .unwrap_or_else(|_| Err(RpcFailure::timeout(method)));
        self.pending.remove(&request_id);
        result
    }

    pub async fn notify(
        &self,
        method: &str,
        params: Option<Value>,
        deadline: Duration,
    ) -> RpcResult<()> {
        let operation = async {
            self.wait_until_ready().await?;
            let message = serde_json::json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params.unwrap_or(Value::Null),
            });
            let mut line = serde_json::to_vec(&message)
                .map_err(|error| RpcFailure::internal(format!("RPC 通知序列化失败: {error}")))?;
            line.push(b'\n');

            let sender = {
                let guard = self
                    .stdin_tx
                    .lock()
                    .map_err(|_| RpcFailure::internal("stdin_tx 锁已中毒"))?;
                guard
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| RpcFailure::unavailable("Backend stdin 通道已关闭"))?
            };
            sender
                .send(line)
                .await
                .map_err(|_| RpcFailure::unavailable("Backend stdin 写入队列已关闭"))
        };

        tokio::time::timeout(deadline, operation)
            .await
            .unwrap_or_else(|_| Err(RpcFailure::timeout(method)))
    }

    pub fn resolve_response(&self, id: &str, result: RpcResult<Value>) {
        if let Some((_, pending)) = self.pending.remove(id) {
            let _ = pending.tx.send(result);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[tokio::test]
    async fn request_deadline_covers_readiness_wait() {
        let stdin = Arc::new(StdMutex::new(None));
        let (_ready_tx, ready_rx) = watch::channel(false);
        let client = RpcClient::new(stdin, ready_rx);
        let error = client
            .request("echo", None, Duration::from_millis(10))
            .await
            .expect_err("request should time out while backend is not ready");
        assert_eq!(error.code, -32002);
    }
}
