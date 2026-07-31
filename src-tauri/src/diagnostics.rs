use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{command, AppHandle, Manager, State};

use crate::commands::AppState;
use crate::redaction::{redact_text, redact_value};

#[derive(Serialize)]
pub struct DiagnosticsExportResult {
    path: String,
}

#[command]
pub async fn diagnostics_export(
    frontend_state: Option<Value>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<DiagnosticsExportResult, String> {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let status = state.health.snapshot();
    let logs = state
        .backend
        .lock()
        .await
        .log_snapshot()
        .into_iter()
        .map(|log| {
            serde_json::json!({
                "seq": log.seq,
                "timestamp_ms": log.timestamp_ms,
                "level": log.level,
                "stream": log.stream,
                "source": log.source,
                "message": redact_text(&log.message),
            })
        })
        .collect::<Vec<_>>();
    let payload = serde_json::json!({
        "schema_version": 1,
        "generated_at_ms": timestamp_ms,
        "application": {
            "name": env!("CARGO_PKG_NAME"),
            "version": env!("CARGO_PKG_VERSION"),
            "debug": cfg!(debug_assertions),
        },
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "backend": status,
        "logs": logs,
        "frontend": frontend_state.as_ref().map(redact_value),
    });

    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve application data directory: {error}"))?
        .join("diagnostics");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Unable to create diagnostics directory: {error}"))?;
    let path = directory.join(format!("diagnostics-{timestamp_ms}.json"));
    let contents = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("Unable to serialize diagnostics: {error}"))?;
    std::fs::write(&path, contents)
        .map_err(|error| format!("Unable to write diagnostics: {error}"))?;

    Ok(DiagnosticsExportResult {
        path: path.to_string_lossy().into_owned(),
    })
}
