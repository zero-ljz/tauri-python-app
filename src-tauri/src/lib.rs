mod bridge;
mod commands;
mod rpc;
mod sidecar;

use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use bridge::EventBridge;
use commands::{rpc_notify, rpc_request, sidecar_logs, sidecar_status, sidecar_stop, AppState};
use rpc::RpcClient;
use sidecar::SidecarManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 挂载 Tauri 默认插件与外部命令插件
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();

            // 1. 初始化 Sidecar管理器，提前取出就绪通知器供 RpcClient 共享
            let sidecar_mgr = SidecarManager::new(app_handle.clone());
            let ready_notify = sidecar_mgr.ready_notify();
            let sidecar = Arc::new(Mutex::new(sidecar_mgr));

            // 2. 初始化 Rpc客户端（共享 Sidecar管理器用于输出写入，共享 Notify 替代忙轮询）
            let rpc = Arc::new(RpcClient::new(Arc::clone(&sidecar), ready_notify));

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
            let rpc_on_exit = Arc::clone(&rpc);
            let app_on_exit = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut sidecar_guard = sidecar.lock().await;
                let on_msg: Arc<dyn Fn(serde_json::Value) + Send + Sync> = Arc::new(move |msg| {
                    bridge_clone.handle_message(msg);
                });
                let on_exit: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                    rpc_on_exit.mark_unready("Sidecar 进程已退出");
                    let _ = app_on_exit.emit(
                        "sidecar://sidecar.exited",
                        serde_json::json!({ "reason": "process exited" }),
                    );
                });
                if let Err(e) = sidecar_guard.start(on_msg, Arc::clone(&on_exit)).await {
                    log::warn!("[setup] Sidecar 进程未能成功拉起: {}", e);
                    (on_exit)();
                }
            });

            Ok(())
        })
        // 绑定注册前端可调用的 Tauri Commands
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            sidecar_logs,
            sidecar_stop,
            rpc_request,
            rpc_notify,
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 主应用时发生异常");
}
