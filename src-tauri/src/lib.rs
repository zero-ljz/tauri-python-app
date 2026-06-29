mod event_bridge;
mod protocol;
mod rpc_client;
mod sidecar_manager;

use sidecar_manager::{
    sidecar_call, sidecar_cancel_task, sidecar_notify, sidecar_ping, sidecar_start_task,
    sidecar_task_catalog, sidecar_task_status, SidecarManager,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(SidecarManager::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_call,
            sidecar_notify,
            sidecar_ping,
            sidecar_task_catalog,
            sidecar_start_task,
            sidecar_cancel_task,
            sidecar_task_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
