use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri_plugin_shell::process::CommandChild;
use tokio::{
    sync::{oneshot, Mutex},
    time::timeout,
};

use crate::{
    event_bridge::EventBridge,
    protocol::{
        parse_inbound, InboundMessage, JsonRpcErrorPayload, JsonRpcNotification, JsonRpcRequest,
    },
};

type PendingSender = oneshot::Sender<Result<Value, JsonRpcErrorPayload>>;

#[derive(Clone)]
pub struct RpcClient {
    child: Arc<Mutex<CommandChild>>,
    pending: Arc<Mutex<HashMap<u64, PendingSender>>>,
    next_id: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
}

impl RpcClient {
    pub fn new(child: CommandChild) -> Self {
        Self {
            child: Arc::new(Mutex::new(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            alive: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn mark_terminated(&self) {
        self.alive.store(false, Ordering::Relaxed);
    }

    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("Python sidecar is not running".to_string());
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        let mut line = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
        line.push(b'\n');

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let mut child = self.child.lock().await;
        if let Err(error) = child.write(&line) {
            drop(child);
            self.mark_terminated();
            self.pending.lock().await.remove(&id);
            return Err(format!("failed to write sidecar stdin: {error}"));
        }
        drop(child);

        match timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(format!(
                "sidecar JSON-RPC error {}: {}",
                error.code, error.message
            )),
            Ok(Err(_closed)) => Err("sidecar response channel closed".to_string()),
            Err(_elapsed) => {
                self.pending.lock().await.remove(&id);
                Err(format!("sidecar request timed out: {method}"))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        if !self.is_alive() {
            return Err("Python sidecar is not running".to_string());
        }

        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        };
        let mut line = serde_json::to_vec(&notification).map_err(|error| error.to_string())?;
        line.push(b'\n');
        let mut child = self.child.lock().await;
        if let Err(error) = child.write(&line) {
            self.mark_terminated();
            Err(format!("failed to write sidecar stdin: {error}"))
        } else {
            Ok(())
        }
    }

    pub async fn handle_stdout_line(&self, line: Vec<u8>, bridge: &EventBridge) {
        let line = String::from_utf8_lossy(&line).trim().to_string();
        if line.is_empty() {
            return;
        }

        match parse_inbound(&line) {
            Ok(InboundMessage::Response { id, result, error }) => {
                if let Some(tx) = self.pending.lock().await.remove(&id) {
                    let _ = tx.send(match error {
                        Some(error) => Err(error),
                        None => Ok(result.unwrap_or(Value::Null)),
                    });
                } else {
                    bridge.emit_lifecycle(
                        "orphan-response",
                        json!({ "id": id, "line": line }),
                    );
                }
            }
            Ok(InboundMessage::Notification(notification)) => {
                bridge.emit_notification(notification);
            }
            Ok(InboundMessage::Request { id, method, params }) => {
                bridge.emit_lifecycle(
                    "unhandled-request",
                    json!({ "id": id, "method": method, "params": params }),
                );
            }
            Err(error) => {
                bridge.emit_lifecycle("protocol-error", json!({ "error": error, "line": line }));
            }
        }
    }

    pub async fn fail_all_pending(&self, message: &str) {
        let mut pending_guard = self.pending.lock().await;
        let pending = std::mem::take(&mut *pending_guard);
        drop(pending_guard);
        for (_, tx) in pending {
            let _ = tx.send(Err(JsonRpcErrorPayload {
                code: -32098,
                message: message.to_string(),
                data: None,
            }));
        }
    }
}
