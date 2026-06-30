import { observer } from "mobx-react-lite";
import { TitleBar } from "@/components/titlebar/TitleBar";
import { RpcDebugPanel } from "@/components/debug/RpcDebugPanel";
import { PreferencesDialog } from "@/components/preferences/PreferencesDialog";
import { appStore } from "@/stores/app.store";
import { sidecarStore } from "@/stores/sidecar.store";

interface MainLayoutProps {
  children: React.ReactNode;
}

// 极简主布局组件（仅包含自定义标题栏与业务主内容区）
export const MainLayout = observer(({ children }: MainLayoutProps) => {
  const sidecarState = sidecarStore.state;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {/* 顶部自定义标题栏 */}
      <TitleBar />
      
      {/* 主视图内容区域 */}
      <div className="flex flex-1 min-h-0 overflow-hidden" data-sidecar-state={sidecarState}>
        <main className="flex-1 overflow-auto min-h-0">
          {children}
        </main>
        {appStore.debugPanelOpen && (
          <aside className="w-96 max-w-[45vw] min-w-80 shrink-0">
            <RpcDebugPanel />
          </aside>
        )}
      </div>

      <PreferencesDialog />
    </div>
  );
});
