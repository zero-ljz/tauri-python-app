import { observer } from "mobx-react-lite";
import { TitleBar } from "@/components/titlebar/TitleBar";
import { RpcDebugPanel } from "@/components/debug/RpcDebugPanel";
import { PreferencesDialog } from "@/components/preferences/PreferencesDialog";
import { appStore } from "@/stores/app.store";
import { backendStore } from "@/stores/backend.store";
import { APP_DIALOG_PORTAL_ID } from "@/components/ui/dialog";

interface MainLayoutProps {
  children: React.ReactNode;
}

// 极简主布局组件（仅包含自定义标题栏与业务主内容区）
export const MainLayout = observer(({ children }: MainLayoutProps) => {
  const backendState = backendStore.state;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部自定义标题栏 */}
      <TitleBar />

      {/* 主视图内容区域 */}
      <div
        className="relative flex min-h-0 flex-1 overflow-hidden"
        data-backend-state={backendState}
      >
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        {appStore.debugPanelAvailable && appStore.debugPanelOpen && (
          <aside className="w-96 max-w-[45vw] min-w-80 shrink-0">
            <RpcDebugPanel />
          </aside>
        )}

        {/* Dialog portals live inside the body so overlays never cover the native title bar. */}
        <div
          id={APP_DIALOG_PORTAL_ID}
          className="pointer-events-none absolute inset-0 z-50 overflow-hidden"
        />
      </div>

      <PreferencesDialog />
    </div>
  );
});
