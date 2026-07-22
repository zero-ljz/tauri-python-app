use log::warn;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::events::backend_event_name;

const MAX_BACKEND_LOGS: usize = 500;

#[derive(Clone, Serialize)]
pub struct BackendLogPayload {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub level: &'static str,
    pub stream: &'static str,
    pub source: &'static str,
    pub message: String,
}

pub(super) type BackendLogBuffer = Arc<Mutex<VecDeque<BackendLogPayload>>>;

pub(super) fn new_log_buffer() -> BackendLogBuffer {
    Arc::new(Mutex::new(VecDeque::with_capacity(MAX_BACKEND_LOGS)))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn stderr_level(line: &str) -> &'static str {
    let upper = line.to_ascii_uppercase();
    if upper.contains("[ERROR]") || upper.starts_with("ERROR") {
        "error"
    } else if upper.contains("[WARNING]") || upper.contains("[WARN]") || upper.starts_with("WARN") {
        "warning"
    } else if upper.contains("[DEBUG]") || upper.starts_with("DEBUG") {
        "debug"
    } else {
        "info"
    }
}

pub(super) fn emit_backend_log(
    app: &AppHandle,
    logs: &BackendLogBuffer,
    next_log_seq: &Arc<AtomicU64>,
    source: &'static str,
    stream: &'static str,
    message: String,
) {
    let level = if stream == "stderr" {
        stderr_level(&message)
    } else {
        "error"
    };
    let payload = BackendLogPayload {
        seq: next_log_seq.fetch_add(1, Ordering::SeqCst) + 1,
        timestamp_ms: now_ms(),
        level,
        stream,
        source,
        message,
    };

    if let Ok(mut buffer) = logs.lock() {
        buffer.push_back(payload.clone());
        while buffer.len() > MAX_BACKEND_LOGS {
            buffer.pop_front();
        }
    } else {
        warn!("[BackendRuntime] 写入 Backend 日志缓冲区失败");
    }

    if let Err(error) = app.emit(&backend_event_name("backend.log"), payload) {
        warn!("[BackendRuntime] 转发 Backend 日志失败: {}", error);
    }
}
