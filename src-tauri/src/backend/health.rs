use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;
use tokio::sync::watch;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendPhase {
    Stopped,
    Starting,
    Ready,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackendStatusPayload {
    pub phase: BackendPhase,
    pub generation: u64,
    pub running: bool,
    pub ready: bool,
    pub version: Option<String>,
    pub capabilities: Vec<String>,
    pub method_permissions: BTreeMap<String, String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug)]
struct BackendHealthState {
    phase: BackendPhase,
    generation: u64,
    version: Option<String>,
    capabilities: Vec<String>,
    method_permissions: BTreeMap<String, String>,
    last_error: Option<String>,
}

/// Shared backend lifecycle state. A spawned process is only ready after the
/// protocol handshake completes.
pub struct BackendHealth {
    state: Mutex<BackendHealthState>,
    ready_tx: watch::Sender<bool>,
}

impl BackendHealth {
    pub fn new() -> Self {
        let (ready_tx, _ready_rx) = watch::channel(false);
        Self {
            state: Mutex::new(BackendHealthState {
                phase: BackendPhase::Stopped,
                generation: 0,
                version: None,
                capabilities: Vec::new(),
                method_permissions: BTreeMap::new(),
                last_error: None,
            }),
            ready_tx,
        }
    }

    pub fn subscribe_ready(&self) -> watch::Receiver<bool> {
        self.ready_tx.subscribe()
    }

    pub fn begin_start(&self) -> u64 {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        state.generation += 1;
        state.phase = BackendPhase::Starting;
        state.version = None;
        state.capabilities.clear();
        state.method_permissions.clear();
        state.last_error = None;
        let _ = self.ready_tx.send(false);
        state.generation
    }

    pub fn current_generation(&self) -> u64 {
        self.state
            .lock()
            .expect("backend health lock poisoned")
            .generation
    }

    pub fn is_current_generation(&self, generation: u64) -> bool {
        let state = self.state.lock().expect("backend health lock poisoned");
        state.generation == generation
            && matches!(
                state.phase,
                BackendPhase::Starting | BackendPhase::Ready | BackendPhase::Stopping
            )
    }

    pub(super) fn is_stopping_generation(&self, generation: u64) -> bool {
        let state = self.state.lock().expect("backend health lock poisoned");
        state.generation == generation && matches!(state.phase, BackendPhase::Stopping)
    }

    pub fn mark_ready(&self, generation: u64, payload: &Value) -> bool {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        if state.generation != generation || !matches!(state.phase, BackendPhase::Starting) {
            return false;
        }

        state.phase = BackendPhase::Ready;
        state.version = payload
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned);
        state.capabilities = payload
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        state.method_permissions = payload
            .get("method_permissions")
            .and_then(Value::as_object)
            .map(|permissions| {
                permissions
                    .iter()
                    .filter_map(|(method, permission)| {
                        permission
                            .as_str()
                            .map(|permission| (method.clone(), permission.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let _ = self.ready_tx.send(true);
        true
    }

    pub fn begin_stop(&self) -> u64 {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        state.phase = BackendPhase::Stopping;
        let _ = self.ready_tx.send(false);
        state.generation
    }

    pub fn mark_stopped(&self, generation: u64, reason: Option<String>) -> bool {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        if state.generation != generation
            || matches!(state.phase, BackendPhase::Stopped | BackendPhase::Failed)
        {
            return false;
        }
        state.phase = if reason.is_some() {
            BackendPhase::Failed
        } else {
            BackendPhase::Stopped
        };
        state.version = None;
        state.capabilities.clear();
        state.method_permissions.clear();
        state.last_error = reason;
        let _ = self.ready_tx.send(false);
        true
    }

    pub fn fail_current(&self, generation: u64, reason: String) {
        let mut state = self.state.lock().expect("backend health lock poisoned");
        if state.generation != generation {
            return;
        }
        state.phase = BackendPhase::Failed;
        state.version = None;
        state.capabilities.clear();
        state.method_permissions.clear();
        state.last_error = Some(reason);
        let _ = self.ready_tx.send(false);
    }

    pub fn is_running(&self) -> bool {
        let state = self.state.lock().expect("backend health lock poisoned");
        matches!(
            state.phase,
            BackendPhase::Starting | BackendPhase::Ready | BackendPhase::Stopping
        )
    }

    pub fn method_permission(&self, method: &str) -> Option<String> {
        self.state
            .lock()
            .expect("backend health lock poisoned")
            .method_permissions
            .get(method)
            .cloned()
    }

    pub(super) fn is_generation_running(&self, generation: u64) -> bool {
        let state = self.state.lock().expect("backend health lock poisoned");
        state.generation == generation
            && matches!(
                state.phase,
                BackendPhase::Starting | BackendPhase::Ready | BackendPhase::Stopping
            )
    }

    pub fn snapshot(&self) -> BackendStatusPayload {
        let state = self.state.lock().expect("backend health lock poisoned");
        BackendStatusPayload {
            phase: state.phase.clone(),
            generation: state.generation,
            running: matches!(
                state.phase,
                BackendPhase::Starting | BackendPhase::Ready | BackendPhase::Stopping
            ),
            ready: matches!(state.phase, BackendPhase::Ready),
            version: state.version.clone(),
            capabilities: state.capabilities.clone(),
            method_permissions: state.method_permissions.clone(),
            last_error: state.last_error.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_handshake_and_ignores_stale_generation() {
        let health = BackendHealth::new();
        let first = health.begin_start();
        assert!(!health.snapshot().ready);
        assert!(health.mark_ready(
            first,
            &serde_json::json!({
                "version": "1",
                "capabilities": ["echo"],
                "method_permissions": {"echo": "public"}
            }),
        ));
        assert!(health.snapshot().ready);
        assert_eq!(health.method_permission("echo").as_deref(), Some("public"));

        health.mark_stopped(first, None);
        let second = health.begin_start();
        assert!(!health.mark_ready(
            first,
            &serde_json::json!({"version": "stale", "capabilities": []}),
        ));
        assert_eq!(health.snapshot().generation, second);
        assert!(!health.snapshot().ready);
    }
}
