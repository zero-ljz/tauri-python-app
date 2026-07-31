import { observer } from "mobx-react-lite";
import { useCallback, useRef, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppMenu } from "./AppMenu";
import { WindowControls } from "./WindowControls";

// 极简自定义标题栏组件
export const TitleBar = observer(() => {
  const contextMenuOpen = useRef(false);

  const suppressContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (contextMenuOpen.current) {
      return;
    }
    contextMenuOpen.current = true;

    void invoke("show_window_system_menu")
      .catch((error) => {
        console.warn("Failed to show the native window system menu", error);
      })
      .finally(() => {
        contextMenuOpen.current = false;
      });
  }, []);

  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-background text-foreground select-none pr-0 pl-0">
      {/* ── 左边最外边缘：微小的可拖动空白边距（w-2） ── */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Tauri drag regions require pointer context-menu handling. */}
      <div
        role="presentation"
        className="w-2 h-full cursor-default"
        data-tauri-drag-region
        onContextMenu={handleContextMenu}
      />

      {/* ── 左边：菜单栏 ── */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this wrapper prevents titlebar double-click propagation. */}
      <div
        role="presentation"
        className="flex items-center h-full"
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={suppressContextMenu}
      >
        <AppMenu />
      </div>

      {/* ── 居中：纯窗口拖拽区域 ── */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Tauri drag regions require pointer context-menu handling. */}
      <div
        role="presentation"
        className="flex-1 h-full cursor-default"
        data-tauri-drag-region
        onContextMenu={handleContextMenu}
      >
        {/* 允许用户点击此处并拖动窗口 */}
      </div>

      {/* ── 右边：窗口控制按钮（无缝贴边） ── */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: this wrapper prevents titlebar double-click propagation. */}
      <div
        role="presentation"
        className="flex items-center h-full"
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={suppressContextMenu}
      >
        <WindowControls />
      </div>
    </div>
  );
});
