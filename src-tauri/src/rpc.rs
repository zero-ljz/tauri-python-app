use dashmap::DashMap;
use serde::Serialize;
use serde_json::Value;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

use crate::protocol_config::MAX_FRAME_BYTES;

use crate::backend::{StdinMessage, StdinTx};

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

    fn transport(message: impl Into<String>) -> Self {
        Self::new(-32003, message)
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

    fn encode_message(
        method: &str,
        id: Option<&str>,
        params: Option<Value>,
        correlation_id: Option<&str>,
    ) -> RpcResult<Vec<u8>> {
        if params
            .as_ref()
            .is_some_and(|value| !value.is_object() && !value.is_array())
        {
            return Err(RpcFailure::new(
                -32602,
                "JSON-RPC params 必须是 object、array 或省略",
            ));
        }

        let mut message = serde_json::Map::new();
        message.insert("jsonrpc".to_string(), Value::String("2.0".to_string()));
        if let Some(id) = id {
            message.insert("id".to_string(), Value::String(id.to_string()));
        }
        message.insert("method".to_string(), Value::String(method.to_string()));
        if let Some(params) = params {
            message.insert("params".to_string(), params);
        }
        if let Some(correlation_id) = correlation_id {
            message.insert(
                "meta".to_string(),
                serde_json::json!({"correlation_id": correlation_id}),
            );
        }

        let mut line = serde_json::to_vec(&Value::Object(message))
            .map_err(|error| RpcFailure::internal(format!("RPC 消息序列化失败: {error}")))?;
        if line.len() > MAX_FRAME_BYTES {
            return Err(RpcFailure::new(
                -32005,
                format!("RPC 请求超过传输上限（{} bytes）", MAX_FRAME_BYTES),
            ));
        }
        line.push(b'\n');
        Ok(line)
    }

    async fn write_line(&self, line: Vec<u8>) -> RpcResult<()> {
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
        let (written, confirmation) = oneshot::channel();
        sender
            .send(StdinMessage {
                bytes: line,
                written,
            })
            .await
            .map_err(|_| RpcFailure::unavailable("Backend stdin 写入队列已关闭"))?;
        confirmation
            .await
            .map_err(|_| RpcFailure::transport("Backend stdin writer 意外退出"))?
            .map_err(|error| RpcFailure::transport(format!("Backend stdin 写入失败: {error}")))
    }

    async fn request_inner(
        &self,
        method: &str,
        params: Option<Value>,
        deadline: Duration,
        require_ready: bool,
        correlation_id: Option<String>,
    ) -> RpcResult<Value> {
        let id = Uuid::new_v4().to_string();
        let request_id = id.clone();
        let operation = async {
            if require_ready {
                self.wait_until_ready().await?;
            }

            let line = Self::encode_message(method, Some(&id), params, correlation_id.as_deref())?;
            let (tx, rx) = oneshot::channel();
            self.pending
                .insert(request_id.clone(), PendingRequest { tx });

            self.write_line(line).await?;
            rx.await
                .map_err(|_| RpcFailure::unavailable("RPC 响应通道意外关闭"))?
        };

        let result = tokio::time::timeout(deadline, operation)
            .await
            .unwrap_or_else(|_| Err(RpcFailure::timeout(method)));
        self.pending.remove(&request_id);
        result
    }

    pub async fn request_with_correlation(
        &self,
        method: &str,
        params: Option<Value>,
        deadline: Duration,
        correlation_id: Option<String>,
    ) -> RpcResult<Value> {
        self.request_inner(method, params, deadline, true, correlation_id)
            .await
    }

    pub async fn request_before_ready(
        &self,
        method: &str,
        params: Option<Value>,
        deadline: Duration,
    ) -> RpcResult<Value> {
        self.request_inner(method, params, deadline, false, None)
            .await
    }

    async fn notify_inner(
        &self,
        method: &str,
        params: Option<Value>,
        deadline: Duration,
        require_ready: bool,
    ) -> RpcResult<()> {
        let operation = async {
            if require_ready {
                self.wait_until_ready().await?;
            }
            self.write_line(Self::encode_message(method, None, params, None)?)
                .await
        };

        tokio::time::timeout(deadline, operation)
            .await
            .unwrap_or_else(|_| Err(RpcFailure::timeout(method)))
    }

    pub async fn notify(
        &self,
        method: &str,
        params: Option<Value>,
        deadline: Duration,
    ) -> RpcResult<()> {
        self.notify_inner(method, params, deadline, true).await
    }

    pub async fn notify_before_ready(
        &self,
        method: &str,
        params: Option<Value>,
        deadline: Duration,
    ) -> RpcResult<()> {
        self.notify_inner(method, params, deadline, false).await
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
            .request_with_correlation("echo", None, Duration::from_millis(10), None)
            .await
            .expect_err("request should time out while backend is not ready");
        assert_eq!(error.code, -32002);
    }

    #[tokio::test]
    async fn notification_waits_for_actual_writer_confirmation() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        let stdin = Arc::new(StdMutex::new(Some(sender)));
        let (_ready_tx, ready_rx) = watch::channel(true);
        let client = RpcClient::new(stdin, ready_rx);

        let writer = tokio::spawn(async move {
            let message: StdinMessage = receiver.recv().await.unwrap();
            let value: Value = serde_json::from_slice(&message.bytes).unwrap();
            assert_eq!(value["method"], "initialized");
            assert!(value.get("params").is_none());
            message.written.send(Ok(())).unwrap();
        });

        client
            .notify("initialized", None, Duration::from_secs(1))
            .await
            .unwrap();
        writer.await.unwrap();
    }

    #[test]
    fn params_are_omitted_when_absent() {
        let encoded = RpcClient::encode_message("task.list", Some("1"), None, None).unwrap();
        let message: Value = serde_json::from_slice(&encoded).unwrap();
        assert!(message.get("params").is_none());
    }

    #[test]
    fn scalar_params_are_rejected() {
        let error = RpcClient::encode_message("echo", Some("1"), Some(Value::Null), None)
            .expect_err("null params are not valid JSON-RPC structured params");
        assert_eq!(error.code, -32602);
    }

    #[test]
    fn oversized_requests_are_rejected_before_transport() {
        let error = RpcClient::encode_message(
            "echo",
            Some("1"),
            Some(serde_json::json!({"payload": "x".repeat(MAX_FRAME_BYTES)})),
            None,
        )
        .expect_err("oversized requests must be rejected");
        assert_eq!(error.code, -32005);
    }

    #[test]
    fn correlation_id_is_forwarded_as_transport_metadata() {
        let encoded = RpcClient::encode_message("echo", Some("1"), None, Some("frontend-1"))
            .expect("correlated message should encode");
        let message: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(message["meta"]["correlation_id"], "frontend-1");
    }
}
