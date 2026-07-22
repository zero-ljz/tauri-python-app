import { observer } from "mobx-react-lite";
import { useCallback, useRef, type MouseEvent } from "react";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppMenu } from "./AppMenu";
import { WindowControls } from "./WindowControls";

const appWindow = getCurrentWindow();

// 极简自定义标题栏组件
export const TitleBar = observer(() => {
  const contextMenuOpen = useRef(false);

  const handleContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (contextMenuOpen.current) {
      return;
    }
    contextMenuOpen.current = true;

    void (async () => {
      let menu: Menu | null = null;
      try {
        const isMaximized = await appWindow.isMaximized();
        menu = await Menu.new({
          items: [
            {
              id: "titlebar-restore",
              text: "还原",
              enabled: isMaximized,
              action: () => {
                void appWindow.unmaximize().catch(() => {});
              },
            },
            {
              id: "titlebar-minimize",
              text: "最小化",
              action: () => {
                void appWindow.minimize().catch(() => {});
              },
            },
            {
              id: "titlebar-maximize",
              text: "最大化",
              enabled: !isMaximized,
              action: () => {
                void appWindow.maximize().catch(() => {});
              },
            },
            { item: "Separator" },
            {
              id: "titlebar-close",
              text: "关闭",
              action: () => {
                void appWindow.close().catch(() => {});
              },
            },
          ],
        });
        await menu.popup(undefined, appWindow);
      } catch (error) {
        console.warn("Failed to show title bar context menu", error);
      } finally {
        if (menu) {
          await menu.close().catch(() => {});
        }
        contextMenuOpen.current = false;
      }
    })();
  }, []);

  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-background text-foreground select-none pr-0 pl-0">
      {/* ── 左边最外边缘：微小的可拖动空白边距（w-2） ── */}
      <div
        className="w-2 h-full cursor-default"
        data-tauri-drag-region
        onContextMenu={handleContextMenu}
      />

      {/* ── 左边：菜单栏 ── */}
      <div className="flex items-center h-full" onDoubleClick={(event) => event.stopPropagation()}>
        <AppMenu />
      </div>

      {/* ── 居中：纯窗口拖拽区域 ── */}
      <div
        className="flex-1 h-full cursor-default"
        data-tauri-drag-region
        onContextMenu={handleContextMenu}
      >
        {/* 允许用户点击此处并拖动窗口 */}
      </div>

      {/* ── 右边：窗口控制按钮（无缝贴边） ── */}
      <div className="flex items-center h-full" onDoubleClick={(event) => event.stopPropagation()}>
        <WindowControls />
      </div>
    </div>
  );
});
