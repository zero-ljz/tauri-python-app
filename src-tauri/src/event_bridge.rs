use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::protocol::JsonRpcNotification;

pub const SIDECAR_NOTIFICATION_EVENT: &str = "sidecar://notification";
pub const SIDECAR_LOG_EVENT: &str = "sidecar://log";
pub const SIDECAR_LIFECYCLE_EVENT: &str = "sidecar://lifecycle";

#[derive(Clone)]
pub struct EventBridge {
    app: AppHandle,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarLogEvent {
    pub stream: &'static str,
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarLifecycleEvent {
    pub state: &'static str,
    pub detail: Value,
}

impl EventBridge {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub fn emit_notification(&self, notification: JsonRpcNotification) {
        let _ = self.app.emit(SIDECAR_NOTIFICATION_EVENT, notification);
    }

    pub fn emit_log(&self, stream: &'static str, line: String) {
        let _ = self.app.emit(SIDECAR_LOG_EVENT, SidecarLogEvent { stream, line });
    }

    pub fn emit_lifecycle(&self, state: &'static str, detail: Value) {
        let _ = self
            .app
            .emit(SIDECAR_LIFECYCLE_EVENT, SidecarLifecycleEvent { state, detail });
    }
}
