import { observer } from "mobx-react-lite";
import { X } from "lucide-react";
import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";

const appWindow = getCurrentWindow();

// Windows 经典风格窗口控制按钮组件 (最小化、最大化/还原、关闭)
export const WindowControls = observer(() => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;
    let syncTimer: ReturnType<typeof window.setTimeout> | null = null;
    let unlistenResize: (() => void) | null = null;

    const syncMaximized = () => {
      appWindow
        .isMaximized()
        .then((next) => {
          if (mounted) {
            setIsMaximized(next);
          }
        })
        .catch(() => {});
    };

    const scheduleSync = () => {
      if (syncTimer != null) {
        window.clearTimeout(syncTimer);
      }
      syncTimer = window.setTimeout(syncMaximized, 80);
    };

    syncMaximized();
    appWindow
      .onResized(scheduleSync)
      .then((unlisten) => {
        if (mounted) {
          unlistenResize = unlisten;
        } else {
          unlisten();
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
      if (syncTimer != null) {
        window.clearTimeout(syncTimer);
      }
      unlistenResize?.();
    };
  }, []);

  const handleMinimize = () => {
    appWindow.minimize().catch(() => {});
  };

  const handleMaximize = async () => {
    try {
      await appWindow.toggleMaximize();
      setIsMaximized(await appWindow.isMaximized());
    } catch {
      // 窗口状态同步失败时保持当前图标状态。
    }
  };

  const handleClose = () => {
    appWindow.close().catch(() => {});
  };

  return (
    <div className="flex items-center h-full">
      {/* 最小化按钮：悬停变为标准灰色，无圆角直角边，填充高度 */}
      <button
        type="button"
        id="window-minimize"
        onClick={handleMinimize}
        className={cn(
          "flex h-full w-12 items-center justify-center transition-colors cursor-default rounded-none border-none bg-transparent outline-none",
          "hover:bg-accent text-foreground",
        )}
        title="最小化"
      >
        <span className="w-2.5 h-[1px] bg-current" />
      </button>

      {/* 最大化 / 还原按钮：显示标准 Windows 框线或双叠框 */}
      <button
        type="button"
        id="window-maximize"
        onClick={handleMaximize}
        className={cn(
          "flex h-full w-12 items-center justify-center transition-colors cursor-default rounded-none border-none bg-transparent outline-none",
          "hover:bg-accent text-foreground",
        )}
        title={isMaximized ? "还原" : "最大化"}
      >
        {isMaximized ? (
          <div className="relative w-2.5 h-2.5">
            <span className="absolute top-0 right-0 w-2 h-2 border border-current bg-transparent" />
            <span className="absolute bottom-0 left-0 w-2 h-2 border border-current bg-background" />
          </div>
        ) : (
          <span className="w-2.5 h-2.5 border border-current bg-transparent" />
        )}
      </button>

      {/* 关闭按钮：悬停变为 Windows 经典红色背景与白色图标 */}
      <button
        type="button"
        id="window-close"
        onClick={handleClose}
        className={cn(
          "flex h-full w-12 items-center justify-center transition-colors cursor-default rounded-none border-none bg-transparent outline-none",
          "hover:bg-[#e81123] hover:text-white text-foreground",
        )}
        title="关闭"
      >
        <X className="h-3.5 w-3.5 stroke-[1.5]" />
      </button>
    </div>
  );
});
