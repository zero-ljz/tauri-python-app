use anyhow::Result;
use dashmap::DashMap;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

use crate::sidecar::StdinTx;

pub type RequestId = String;

/// 挂起的 RPC 请求记录：持有一个用于完成 Future 的 oneshot 发送端
struct PendingRequest {
    tx: oneshot::Sender<Result<Value>>,
}

/// JSON-RPC 2.0 客户端：通过独立的 stdin 写入通道将请求发送给 Python Sidecar 并接收结果。
///
/// Fix 1：就绪等待改用 `watch::Receiver`，所有并发 waiter 在进程启动时同时被唤醒，
///         不再受 Notify 单 permit 限制。
///
/// Fix 2：直接持有 `stdin_tx`（StdinTx），写入请求不再需要锁住 SidecarManager，
///         彻底解耦 stdin 写入与状态查询之间的锁竞争。
pub struct RpcClient {
    pending: Arc<DashMap<RequestId, PendingRequest>>,
    /// 与 SidecarManager 共享的 stdin 写入通道（Arc 共享，同一进程生命周期内同步清空）
    stdin_tx: StdinTx,
    /// 进程就绪状态订阅端：clone 后独立等待，多个 waiter 同时被唤醒（Fix 1）
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

    /// 标记 Sidecar 不再可用，立即释放所有挂起中的 RPC 请求，并清空 stdin 写入通道。
    ///
    /// Fix 2：清空 stdin_tx 使 writer 任务因 rx 端关闭而自动退出，防止向已退出的进程写入。
    pub fn mark_unready(&self, reason: impl Into<String>) {
        let reason = reason.into();

        // 释放所有挂起请求
        let ids: Vec<RequestId> = self.pending.iter().map(|item| item.key().clone()).collect();
        for id in ids {
            if let Some((_, pending)) = self.pending.remove(&id) {
                let _ = pending.tx.send(Err(anyhow::anyhow!("{}", reason)));
            }
        }

        // 清空 stdin 写入通道（Fix 2）
        if let Ok(mut g) = self.stdin_tx.lock() {
            *g = None;
        }
    }

    /// 等待 Sidecar 进程启动完成。
    ///
    /// Fix 1 核心：通过克隆 `watch::Receiver` 使每个调用方持有独立订阅端，
    /// `sender.send(true)` 时所有 waiter 同时被广播唤醒，彻底解决 Notify 单 permit 问题。
    ///
    /// - 快速路径：当前值已为 true，立即返回（无锁，纯内存读）
    /// - 慢速路径：克隆 receiver 等待值变为 true，10 秒超时兜底
    async fn wait_until_process_running(&self) -> Result<()> {
        // 快速路径：进程已就绪，无需等待
        if *self.ready_rx.borrow() {
            return Ok(());
        }

        // 慢速路径：克隆独立订阅端，不影响其他并发 waiter
        let mut rx = self.ready_rx.clone();
        let result = match tokio::time::timeout(Duration::from_secs(10), rx.wait_for(|&v| v)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(_)) => Err(anyhow::anyhow!("Sidecar 就绪通知通道已关闭")),
            Err(_) => Err(anyhow::anyhow!("Sidecar 进程启动超时，RPC 请求已取消")),
        };
        result
    }

    /// 发送一个 JSON-RPC 2.0 请求并等待响应（带 30 秒超时控制）。
    ///
    /// Fix 2：通过 stdin_tx 直接发送，只需短暂的 StdMutex 锁（clone sender），
    ///         不持有 SidecarManager 的 tokio::Mutex，消除 30 秒等待期间的锁竞争。
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

        // 序列化为 NDJSON（换行符分隔）
        let mut line = serde_json::to_vec(&message)
            .map_err(|e| anyhow::anyhow!("RPC 消息序列化失败: {}", e))?;
        line.push(b'\n');

        // 取出 sender 的克隆（短暂 StdMutex 锁，立即释放，不跨 await）
        let sender = {
            let guard = self
                .stdin_tx
                .lock()
                .map_err(|_| anyhow::anyhow!("stdin_tx 锁已中毒"))?;
            match guard.as_ref() {
                Some(tx) => tx.clone(),
                None => {
                    self.pending.remove(&id);
                    return Err(anyhow::anyhow!("Sidecar 未处于运行状态，stdin 通道已关闭"));
                }
            }
        }; // StdMutex 锁在此释放，后续 await 不持有任何锁

        // 投入 mpsc 队列（异步，非阻塞）
        if sender.send(line).await.is_err() {
            self.pending.remove(&id);
            return Err(anyhow::anyhow!(
                "stdin 写入通道已关闭，Sidecar 可能已退出: {}",
                method
            ));
        }

        // 挂起等待响应，设置 30 秒超时
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
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

        let mut line = serde_json::to_vec(&message)
            .map_err(|e| anyhow::anyhow!("RPC 通知序列化失败: {}", e))?;
        line.push(b'\n');

        // 同上：短暂锁，立即释放
        let sender = {
            let guard = self
                .stdin_tx
                .lock()
                .map_err(|_| anyhow::anyhow!("stdin_tx 锁已中毒"))?;
            match guard.as_ref() {
                Some(tx) => tx.clone(),
                None => return Err(anyhow::anyhow!("Sidecar 未处于运行状态，stdin 通道已关闭")),
            }
        };

        sender
            .send(line)
            .await
            .map_err(|_| anyhow::anyhow!("stdin 写入通道已关闭"))
    }

    /// 当接收到来自 Python 的 RPC 响应时，通过消息 ID 匹配来唤醒对应的 oneshot 接收端
    pub fn resolve_response(&self, id: &str, result: Result<Value>) {
        if let Some((_, pending)) = self.pending.remove(id) {
            let _ = pending.tx.send(result);
        }
    }
}
