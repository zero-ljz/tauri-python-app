mod backend;
mod bridge;
mod commands;
mod rpc;

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use backend::BackendRuntime;
use bridge::EventBridge;
use commands::{
    backend_logs, backend_notify, backend_request, backend_status, backend_stop, AppState,
};
use rpc::RpcClient;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            let backend_runtime = BackendRuntime::new(app_handle.clone());
            let stdin_tx = backend_runtime.stdin_sender();
            let ready_rx = backend_runtime.ready_watch();
            let backend = Arc::new(Mutex::new(backend_runtime));

            let rpc = Arc::new(RpcClient::new(stdin_tx, ready_rx));
            let bridge = Arc::new(EventBridge::new(app_handle.clone(), Arc::clone(&rpc)));

            let state = Arc::new(AppState {
                backend: Arc::clone(&backend),
                rpc: Arc::clone(&rpc),
            });
            app.manage(state);

            let bridge_clone = Arc::clone(&bridge);
            let rpc_on_exit = Arc::clone(&rpc);
            let app_on_exit = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut backend_guard = backend.lock().await;
                let on_msg: Arc<dyn Fn(serde_json::Value) + Send + Sync> = Arc::new(move |msg| {
                    bridge_clone.handle_message(msg);
                });
                let on_exit: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                    rpc_on_exit.mark_unready("Backend process exited");
                    let _ = app_on_exit.emit(
                        "backend://backend.exited",
                        serde_json::json!({ "reason": "process exited" }),
                    );
                });
                if let Err(e) = backend_guard.start(on_msg, Arc::clone(&on_exit)).await {
                    log::warn!("[setup] Backend process failed to start: {}", e);
                    (on_exit)();
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_status,
            backend_logs,
            backend_stop,
            backend_request,
            backend_notify,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tauri app");
}
