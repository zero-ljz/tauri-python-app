use anyhow::Result;
use dashmap::DashMap;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

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

    /// 标记 Sidecar 不再可用，并立即释放所有挂起中的 RPC 请求。
    pub fn mark_unready(&self, reason: impl Into<String>) {
        let reason = reason.into();
        let ids: Vec<RequestId> = self.pending.iter().map(|item| item.key().clone()).collect();

        for id in ids {
            if let Some((_, pending)) = self.pending.remove(&id) {
                let _ = pending.tx.send(Err(anyhow::anyhow!("{}", reason)));
            }
        }
    }

    /// 等待 Sidecar 进程启动完成。
    /// ready 通知只用于能力表/UI 状态，不作为传输层硬门禁。
    async fn wait_until_process_running(&self) -> Result<()> {
        let timeout = std::time::Duration::from_secs(10);
        let started_at = std::time::Instant::now();

        loop {
            {
                let sidecar = self.sidecar.lock().await;
                if sidecar.is_running() {
                    return Ok(());
                }
            }

            if started_at.elapsed() >= timeout {
                return Err(anyhow::anyhow!("Sidecar 进程尚未运行，RPC 请求已取消"));
            }

            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// 发送一个 JSON-RPC 2.0 请求并等待响应（带 30 秒超时控制）
    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value> {
        self.wait_until_process_running().await?;

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
            if let Err(e) = sidecar.write_message(&message).await {
                self.pending.remove(&id);
                return Err(e);
            }
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
        self.wait_until_process_running().await?;

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
