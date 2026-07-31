use tauri::{command, WebviewWindow};

#[command]
pub async fn show_window_system_menu(window: WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        let menu_window = window.clone();
        let (sender, receiver) = tokio::sync::oneshot::channel();

        window
            .run_on_main_thread(move || {
                let _ = sender.send(show_native_system_menu(&menu_window));
            })
            .map_err(|error| format!("Unable to schedule the native system menu: {error}"))?;

        receiver
            .await
            .map_err(|_| "The native system menu task was cancelled".to_string())?
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        Err("The native window system menu is only available on Windows".to_string())
    }
}

#[cfg(windows)]
fn show_native_system_menu(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::{LPARAM, POINT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnableMenuItem, GetCursorPos, GetSystemMenu, IsZoomed, PostMessageW, SetForegroundWindow,
        TrackPopupMenu, MF_BYCOMMAND, MF_ENABLED, MF_GRAYED, SC_MAXIMIZE, SC_MINIMIZE, SC_MOVE,
        SC_RESTORE, SC_SIZE, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_NULL, WM_SYSCOMMAND,
    };

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Unable to resolve the native window handle: {error}"))?;

    unsafe {
        let menu = GetSystemMenu(hwnd, false);
        if menu.0.is_null() {
            return Err("Windows did not provide a system menu for this window".to_string());
        }

        let is_maximized = IsZoomed(hwnd).as_bool();
        for (command, enabled) in [
            (SC_RESTORE, is_maximized),
            (SC_MOVE, !is_maximized),
            (SC_SIZE, !is_maximized),
            (SC_MINIMIZE, true),
            (SC_MAXIMIZE, !is_maximized),
        ] {
            let state = if enabled { MF_ENABLED } else { MF_GRAYED };
            let _ = EnableMenuItem(menu, command, MF_BYCOMMAND | state);
        }

        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor)
            .map_err(|error| format!("Unable to locate the pointer: {error}"))?;

        let _ = SetForegroundWindow(hwnd);
        let selected = TrackPopupMenu(
            menu,
            TPM_LEFTALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD,
            cursor.x,
            cursor.y,
            None,
            hwnd,
            None,
        );

        if selected.0 != 0 {
            PostMessageW(
                Some(hwnd),
                WM_SYSCOMMAND,
                WPARAM(selected.0 as usize),
                LPARAM(0),
            )
            .map_err(|error| format!("Unable to execute the system menu command: {error}"))?;
        }

        // Required by TrackPopupMenu so clicking elsewhere always dismisses the menu.
        PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0))
            .map_err(|error| format!("Unable to finalize the system menu: {error}"))?;
    }

    Ok(())
}
