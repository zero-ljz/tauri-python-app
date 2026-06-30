import { observer } from "mobx-react-lite";
import { useState, useEffect } from "react";
import { Menu } from "lucide-react";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appStore } from "@/stores/app.store";

const appWindow = getCurrentWindow();

// 具有 Windows 原生体验且支持平铺自适应折叠的菜单栏组件
export const AppMenu = observer(() => {
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleExit = () => {
    appWindow.close().catch(() => {});
  };

  // 优化折叠阈值：只有在空间确实非常紧凑时才启动阶梯式折叠
  const showHelp = windowWidth >= 420; // 窗口小于 420px 时折叠 "帮助"
  const showView = windowWidth >= 360; // 窗口小于 360px 时折叠 "视图"
  const showEdit = windowWidth >= 300; // 窗口小于 300px 时折叠 "编辑"

  const hasCollapsed = !showHelp || !showView || !showEdit;

  return (
    <Menubar className="border-none bg-transparent shadow-none h-full rounded-none p-0 space-x-0">
      {/* ── 1. App 菜单（始终显示） ── */}
      <MenubarMenu>
        <MenubarTrigger className="h-full rounded-none px-3 py-0 text-xs cursor-default">App</MenubarTrigger>
        <MenubarContent className="mt-[-1px]">
          <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground select-none">
            tauri-python-app
          </div>
          <MenubarSeparator />
          <MenubarItem onClick={() => appStore.openPreferences()} className="cursor-pointer">
            偏好设置
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onClick={handleExit} className="text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer">
            退出
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      {/* ── 2. 编辑 ── */}
      {showEdit && (
        <MenubarMenu>
          <MenubarTrigger className="h-full rounded-none px-3 py-0 text-xs cursor-default">编辑</MenubarTrigger>
          <MenubarContent className="mt-[-1px]">
            <MenubarItem className="cursor-pointer">撤销</MenubarItem>
            <MenubarItem className="cursor-pointer">重做</MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="cursor-pointer">剪切</MenubarItem>
            <MenubarItem className="cursor-pointer">复制</MenubarItem>
            <MenubarItem className="cursor-pointer">粘贴</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      )}

      {/* ── 3. 视图 ── */}
      {showView && (
        <MenubarMenu>
          <MenubarTrigger className="h-full rounded-none px-3 py-0 text-xs cursor-default">视图</MenubarTrigger>
          <MenubarContent className="mt-[-1px]">
            <MenubarItem className="cursor-pointer">重新加载</MenubarItem>
            <MenubarItem className="cursor-pointer">切换全屏</MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => appStore.toggleDebugPanel()} className="cursor-pointer">
              {appStore.debugPanelOpen ? "隐藏 IPC 调试面板" : "显示 IPC 调试面板"}
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      )}

      {/* ── 4. 帮助 ── */}
      {showHelp && (
        <MenubarMenu>
          <MenubarTrigger className="h-full rounded-none px-3 py-0 text-xs cursor-default">帮助</MenubarTrigger>
          <MenubarContent className="mt-[-1px]">
            <MenubarItem className="cursor-pointer">关于</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      )}

      {/* ── 5. 汉堡折叠按钮（平铺结构，防止级联菜单溢出窗口） ── */}
      {hasCollapsed && (
        <MenubarMenu>
          {/* 将“更多”文案替换为标准的汉堡三道杠图标 */}
          <MenubarTrigger className="h-full rounded-none px-3 py-0 cursor-default">
            <Menu className="h-3.5 w-3.5 text-muted-foreground" />
          </MenubarTrigger>
          <MenubarContent className="mt-[-1px]">
            
            {/* 折叠后的“编辑”选项：在单一列表内平铺，不采用二级子菜单 */}
            {!showEdit && (
              <>
                <div className="px-2 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider select-none">
                  编辑
                </div>
                <MenubarItem className="cursor-pointer">撤销</MenubarItem>
                <MenubarItem className="cursor-pointer">重做</MenubarItem>
                <MenubarItem className="cursor-pointer">剪切</MenubarItem>
                <MenubarItem className="cursor-pointer">复制</MenubarItem>
                <MenubarItem className="cursor-pointer">粘贴</MenubarItem>
              </>
            )}

            {/* 折叠后的“视图”选项 */}
            {!showView && (
              <>
                {!showEdit && <MenubarSeparator />}
                <div className="px-2 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider select-none">
                  视图
                </div>
                <MenubarItem className="cursor-pointer">重新加载</MenubarItem>
                <MenubarItem className="cursor-pointer">切换全屏</MenubarItem>
                <MenubarItem onClick={() => appStore.toggleDebugPanel()} className="cursor-pointer">
                  {appStore.debugPanelOpen ? "隐藏 IPC 调试面板" : "显示 IPC 调试面板"}
                </MenubarItem>
              </>
            )}

            {/* 折叠后的“帮助”选项 */}
            {!showHelp && (
              <>
                {(!showEdit || !showView) && <MenubarSeparator />}
                <div className="px-2 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider select-none">
                  帮助
                </div>
                <MenubarItem className="cursor-pointer">关于</MenubarItem>
              </>
            )}
            
          </MenubarContent>
        </MenubarMenu>
      )}
    </Menubar>
  );
});
