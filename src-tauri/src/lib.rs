mod backend;
mod bridge;
mod commands;
mod events;
mod rpc;

use std::sync::Arc;
use tauri::{Manager, WindowEvent};
use tokio::sync::Mutex;

use backend::{BackendHealth, BackendRuntime};
use bridge::EventBridge;
use commands::{
    backend_logs, backend_notify, backend_request, backend_restart, backend_start, backend_status,
    backend_stop, AppState,
};
use rpc::RpcClient;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                log::info!("main window close requested; beginning backend shutdown");
                api.prevent_close();
                let app_handle = window.app_handle().clone();
                if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                    let state = Arc::clone(state.inner());
                    if state.begin_shutdown() {
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) =
                                state.stop_backend("Application is shutting down").await
                            {
                                log::error!("backend shutdown failed: {error}");
                            }
                            log::info!("backend shutdown complete; exiting application");
                            app_handle.exit(0);
                        });
                    }
                } else {
                    app_handle.exit(0);
                }
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();

            let health = Arc::new(BackendHealth::new());
            let backend_runtime = BackendRuntime::new(app_handle.clone(), Arc::clone(&health));
            let stdin_tx = backend_runtime.stdin_sender();
            let ready_rx = backend_runtime.ready_watch();
            let backend = Arc::new(Mutex::new(backend_runtime));

            let rpc = Arc::new(RpcClient::new(stdin_tx, ready_rx));
            let bridge = Arc::new(EventBridge::new(
                app_handle.clone(),
                Arc::clone(&rpc),
                Arc::clone(&health),
            ));

            let state = Arc::new(AppState::new(
                Arc::clone(&backend),
                Arc::clone(&rpc),
                bridge,
                health,
            ));
            app.manage(Arc::clone(&state));

            let start_state = Arc::clone(&state);
            let start_app = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_state.start_backend(start_app).await {
                    log::warn!("[setup] Backend process failed to start: {}", error);
                }
            });

            // The configured window starts hidden to avoid startup flashing. If
            // WebView creation or frontend bootstrap fails, do not leave a
            // headless app and Python sidecar running forever.
            let watchdog_state = Arc::clone(&state);
            let watchdog_app = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                let window_visible = watchdog_app
                    .get_webview_window("main")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                if !window_visible && watchdog_state.begin_shutdown() {
                    log::error!("main window did not become visible; shutting down headless app");
                    let _ = watchdog_state
                        .stop_backend("Main window failed to initialize")
                        .await;
                    watchdog_app.exit(1);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_status,
            backend_logs,
            backend_start,
            backend_stop,
            backend_restart,
            backend_request,
            backend_notify,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri app");
}
