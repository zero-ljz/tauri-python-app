mod sidecar;
mod rpc;
mod bridge;
mod commands;

use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::Manager;

use sidecar::SidecarManager;
use rpc::RpcClient;
use bridge::EventBridge;
use commands::{
    AppState,
    sidecar_status, sidecar_stop,
    rpc_request, rpc_notify,
    window_minimize, window_maximize, window_close,
    window_is_maximized, window_start_drag,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 挂载 Tauri 默认插件与外部命令插件
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 1. 初始化 Sidecar管理器
            let sidecar = Arc::new(Mutex::new(SidecarManager::new(app_handle.clone())));

            // 2. 初始化 Rpc客户端（共享 Sidecar管理器用于输出写入）
            let rpc = Arc::new(RpcClient::new(Arc::clone(&sidecar)));

            // 3. 初始化 消息网桥调度器
            let bridge = Arc::new(EventBridge::new(app_handle.clone(), Arc::clone(&rpc)));

            // 4. 将应用状态注册托管到 Tauri Context 中
            let state = Arc::new(AppState {
                sidecar: Arc::clone(&sidecar),
                rpc: Arc::clone(&rpc),
            });
            app.manage(state);

            // 5. 启动 Sidecar 进程并开始监听管道输出
            let bridge_clone = Arc::clone(&bridge);
            tauri::async_runtime::spawn(async move {
                let mut sidecar_guard = sidecar.lock().await;
                let on_msg = move |msg| {
                    bridge_clone.handle_message(msg);
                };
                if let Err(e) = sidecar_guard.start(on_msg).await {
                    log::warn!("[setup] Sidecar 进程未能成功拉起: {}", e);
                }
            });

            Ok(())
        })
        // 绑定注册前端可调用的 Tauri Commands
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            sidecar_stop,
            rpc_request,
            rpc_notify,
            window_minimize,
            window_maximize,
            window_close,
            window_is_maximized,
            window_start_drag,
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 主应用时发生异常");
}
