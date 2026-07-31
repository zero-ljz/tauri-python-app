use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{command, AppHandle, Emitter, State, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::commands::AppState;

const UPDATER_PUBLIC_KEY: Option<&str> = option_env!("TAURI_UPDATER_PUBLIC_KEY");
const UPDATER_ENDPOINT: Option<&str> = option_env!("TAURI_UPDATER_ENDPOINT");

#[derive(Serialize)]
pub struct UpdaterStatus {
    configured: bool,
    current_version: &'static str,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

fn updater_configuration() -> Result<(&'static str, Url), String> {
    let public_key = UPDATER_PUBLIC_KEY
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Updater public key is not configured".to_string())?;
    let endpoint = UPDATER_ENDPOINT
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Updater endpoint is not configured".to_string())?;
    let endpoint =
        Url::parse(endpoint).map_err(|error| format!("Invalid updater endpoint: {error}"))?;
    if endpoint.scheme() != "https" {
        return Err("Updater endpoint must use HTTPS".to_string());
    }
    Ok((public_key, endpoint))
}

fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let (public_key, endpoint) = updater_configuration()?;
    app.updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

async fn confirm_install(app: &AppHandle, version: &str) -> Result<bool, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "A signed update to version {version} is ready to install. The application will restart."
        ))
        .title("Install application update")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install and restart".to_string(),
            "Later".to_string(),
        ))
        .show(move |approved| {
            let _ = sender.send(approved);
        });
    receiver
        .await
        .map_err(|_| "Update confirmation dialog closed unexpectedly".to_string())
}

#[command]
pub fn updater_status() -> UpdaterStatus {
    UpdaterStatus {
        configured: updater_configuration().is_ok(),
        current_version: env!("CARGO_PKG_VERSION"),
    }
}

#[command]
pub async fn updater_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = build_updater(&app)?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateInfo {
        version: update.version,
        current_version: update.current_version,
        notes: update.body,
        date: update.date.map(|date| date.to_string()),
    }))
}

#[command]
pub async fn updater_install(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let update = build_updater(&app)?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "No application update is available".to_string())?;
    if !confirm_install(&app, &update.version).await? {
        return Err("Update installation was cancelled".to_string());
    }

    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                let _ = progress_app.emit(
                    "updater://progress",
                    serde_json::json!({"chunk_bytes": chunk, "total_bytes": total}),
                );
            },
            {
                let app = app.clone();
                move || {
                    let _ = app.emit("updater://downloaded", ());
                }
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    state
        .stop_backend("Application update is installing")
        .await?;
    update.install(bytes).map_err(|error| error.to_string())?;
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_is_inert_without_release_configuration() {
        if UPDATER_PUBLIC_KEY.is_none() || UPDATER_ENDPOINT.is_none() {
            assert!(updater_configuration().is_err());
        }
    }
}
