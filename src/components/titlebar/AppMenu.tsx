import { observer } from "mobx-react-lite";
import { Menu } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appStore } from "@/stores/app.store";

const appWindow = getCurrentWindow();

type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";
type TopLevelMenu = "app" | "edit" | "view" | "help" | "more";

interface EditMenuItemsProps {
  onCommand: (command: EditCommand) => void;
}

const EditMenuItems = ({ onCommand }: EditMenuItemsProps) => (
  <>
    <MenubarItem onSelect={() => onCommand("undo")} aria-keyshortcuts="Control+Z">
      撤销
      <MenubarShortcut>Ctrl+Z</MenubarShortcut>
    </MenubarItem>
    <MenubarItem onSelect={() => onCommand("redo")} aria-keyshortcuts="Control+Y">
      重做
      <MenubarShortcut>Ctrl+Y</MenubarShortcut>
    </MenubarItem>
    <MenubarSeparator />
    <MenubarItem onSelect={() => onCommand("cut")} aria-keyshortcuts="Control+X">
      剪切
      <MenubarShortcut>Ctrl+X</MenubarShortcut>
    </MenubarItem>
    <MenubarItem onSelect={() => onCommand("copy")} aria-keyshortcuts="Control+C">
      复制
      <MenubarShortcut>Ctrl+C</MenubarShortcut>
    </MenubarItem>
    <MenubarItem onSelect={() => onCommand("paste")} aria-keyshortcuts="Control+V">
      粘贴
      <MenubarShortcut>Ctrl+V</MenubarShortcut>
    </MenubarItem>
    <MenubarItem onSelect={() => onCommand("selectAll")} aria-keyshortcuts="Control+A">
      全选
      <MenubarShortcut>Ctrl+A</MenubarShortcut>
    </MenubarItem>
  </>
);

interface ViewMenuItemsProps {
  onReload: () => void;
  onToggleFullscreen: () => void;
}

const ViewMenuItems = ({ onReload, onToggleFullscreen }: ViewMenuItemsProps) => (
  <>
    <MenubarItem onSelect={onReload} aria-keyshortcuts="Control+R">
      重新加载
      <MenubarShortcut>Ctrl+R</MenubarShortcut>
    </MenubarItem>
    <MenubarItem onSelect={onToggleFullscreen} aria-keyshortcuts="F11">
      切换全屏
      <MenubarShortcut>F11</MenubarShortcut>
    </MenubarItem>
    {appStore.debugPanelAvailable && (
      <>
        <MenubarSeparator />
        <MenubarCheckboxItem
          checked={appStore.debugPanelOpen}
          onCheckedChange={() => appStore.toggleDebugPanel()}
        >
          IPC 调试面板
        </MenubarCheckboxItem>
      </>
    )}
  </>
);

export const AppMenu = observer(() => {
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [openMenu, setOpenMenu] = useState("");
  const triggerRefs = useRef<Partial<Record<TopLevelMenu, HTMLButtonElement | null>>>({});
  const lastEditableElement = useRef<HTMLElement | null>(null);

  const showHelp = windowWidth >= 420;
  const showView = windowWidth >= 360;
  const showEdit = windowWidth >= 300;
  const hasCollapsed = !showHelp || !showView || !showEdit;

  const handleExit = useCallback(() => {
    void appWindow.close().catch(() => {});
  }, []);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    void appWindow
      .isFullscreen()
      .then((fullscreen) => appWindow.setFullscreen(!fullscreen))
      .catch(() => {});
  }, []);

  const handleAbout = useCallback(() => {
    window.alert(
      "tauri-python-app\n版本 0.1.0\n\nTauri v2、React、Rust 与 Python sidecar 应用模板",
    );
  }, []);

  const handleEditCommand = useCallback((command: EditCommand) => {
    const target = lastEditableElement.current;
    if (target?.isConnected) {
      target.focus({ preventScroll: true });
    }
    document.execCommand(command);
  }, []);

  const focusTopLevelMenu = useCallback((menu: TopLevelMenu, expand: boolean) => {
    const trigger = triggerRefs.current[menu];
    if (!trigger) return;
    trigger.focus({ preventScroll: true });
    setOpenMenu(expand ? menu : "");
  }, []);

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const rememberEditableElement = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        lastEditableElement.current = target;
      }
    };

    document.addEventListener("focusin", rememberEditableElement);
    return () => document.removeEventListener("focusin", rememberEditableElement);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.defaultPrevented) return;

      const primaryModifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (primaryModifier && !event.altKey && !event.shiftKey) {
        if (key === "q") {
          event.preventDefault();
          handleExit();
          return;
        }
        if (key === "," || event.code === "Comma") {
          event.preventDefault();
          appStore.openPreferences();
          return;
        }
        if (key === "r") {
          event.preventDefault();
          handleReload();
          return;
        }
      }

      if (!primaryModifier && !event.altKey && !event.shiftKey && event.key === "F10") {
        event.preventDefault();
        focusTopLevelMenu("app", false);
        return;
      }

      if (!primaryModifier && !event.altKey && !event.shiftKey && event.key === "F11") {
        event.preventDefault();
        handleToggleFullscreen();
        return;
      }

      if (event.altKey && !primaryModifier && !event.shiftKey) {
        const menu = {
          a: "app",
          e: showEdit ? "edit" : "more",
          v: showView ? "view" : "more",
          h: showHelp ? "help" : "more",
        }[key] as TopLevelMenu | undefined;

        if (menu) {
          event.preventDefault();
          focusTopLevelMenu(menu, true);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    focusTopLevelMenu,
    handleExit,
    handleReload,
    handleToggleFullscreen,
    showEdit,
    showHelp,
    showView,
  ]);

  return (
    <Menubar
      value={openMenu}
      onValueChange={setOpenMenu}
      loop
      aria-label="应用菜单"
      className="h-full space-x-0 rounded-none border-none bg-transparent p-0 shadow-none"
    >
      <MenubarMenu value="app">
        <MenubarTrigger
          ref={(node) => {
            triggerRefs.current.app = node;
          }}
          aria-label="App 菜单"
          aria-keyshortcuts="Alt+A"
          className="h-full rounded-none px-3 py-0 text-xs"
        >
          App
        </MenubarTrigger>
        <MenubarContent className="mt-[-1px]">
          <MenubarLabel className="text-muted-foreground">tauri-python-app</MenubarLabel>
          <MenubarSeparator />
          <MenubarItem onSelect={() => appStore.openPreferences()} aria-keyshortcuts="Control+,">
            偏好设置
            <MenubarShortcut>Ctrl+,</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem
            onSelect={handleExit}
            aria-keyshortcuts="Control+Q"
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          >
            退出
            <MenubarShortcut>Ctrl+Q</MenubarShortcut>
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      {showEdit && (
        <MenubarMenu value="edit">
          <MenubarTrigger
            ref={(node) => {
              triggerRefs.current.edit = node;
            }}
            aria-label="编辑菜单"
            aria-keyshortcuts="Alt+E"
            className="h-full rounded-none px-3 py-0 text-xs"
          >
            编辑
          </MenubarTrigger>
          <MenubarContent className="mt-[-1px]">
            <EditMenuItems onCommand={handleEditCommand} />
          </MenubarContent>
        </MenubarMenu>
      )}

      {showView && (
        <MenubarMenu value="view">
          <MenubarTrigger
            ref={(node) => {
              triggerRefs.current.view = node;
            }}
            aria-label="视图菜单"
            aria-keyshortcuts="Alt+V"
            className="h-full rounded-none px-3 py-0 text-xs"
          >
            视图
          </MenubarTrigger>
          <MenubarContent className="mt-[-1px]">
            <ViewMenuItems onReload={handleReload} onToggleFullscreen={handleToggleFullscreen} />
          </MenubarContent>
        </MenubarMenu>
      )}

      {showHelp && (
        <MenubarMenu value="help">
          <MenubarTrigger
            ref={(node) => {
              triggerRefs.current.help = node;
            }}
            aria-label="帮助菜单"
            aria-keyshortcuts="Alt+H"
            className="h-full rounded-none px-3 py-0 text-xs"
          >
            帮助
          </MenubarTrigger>
          <MenubarContent className="mt-[-1px]">
            <MenubarItem onSelect={handleAbout}>关于 tauri-python-app</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      )}

      {hasCollapsed && (
        <MenubarMenu value="more">
          <MenubarTrigger
            ref={(node) => {
              triggerRefs.current.more = node;
            }}
            aria-label="更多菜单"
            className="h-full rounded-none px-3 py-0"
          >
            <Menu className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">更多菜单</span>
          </MenubarTrigger>
          <MenubarContent className="mt-[-1px]">
            {!showEdit && (
              <>
                <MenubarLabel className="text-muted-foreground">编辑</MenubarLabel>
                <EditMenuItems onCommand={handleEditCommand} />
              </>
            )}

            {!showView && (
              <>
                {!showEdit && <MenubarSeparator />}
                <MenubarLabel className="text-muted-foreground">视图</MenubarLabel>
                <ViewMenuItems
                  onReload={handleReload}
                  onToggleFullscreen={handleToggleFullscreen}
                />
              </>
            )}

            {!showHelp && (
              <>
                {(!showEdit || !showView) && <MenubarSeparator />}
                <MenubarLabel className="text-muted-foreground">帮助</MenubarLabel>
                <MenubarItem onSelect={handleAbout}>关于 tauri-python-app</MenubarItem>
              </>
            )}
          </MenubarContent>
        </MenubarMenu>
      )}
    </Menubar>
  );
});
