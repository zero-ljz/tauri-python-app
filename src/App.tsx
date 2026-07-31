import { observer } from "mobx-react-lite";
import { MainLayout } from "@/components/layout/MainLayout";
import { backendStore } from "@/stores/backend.store";
import { backendStart } from "@/lib/rpc";
import { Button } from "@/components/ui/button";
import { AlertTriangle, LoaderCircle } from "lucide-react";

// 极简应用主入口视图组件
const App = observer(() => {
  const retry = async () => {
    backendStore.setState("starting");
    try {
      await backendStart();
    } catch (error) {
      backendStore.setState("error");
      console.error("Backend retry failed", error);
    }
  };

  return (
    <MainLayout>
      <div className="flex h-full w-full flex-col bg-muted">
        {(backendStore.state === "starting" || backendStore.state === "unknown") && (
          <div
            className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Backend 正在启动
          </div>
        )}
        {(backendStore.state === "error" || backendStore.state === "stopped") && (
          <div className="flex flex-1 items-center justify-center p-6" role="alert">
            <div className="max-w-md space-y-3 rounded-lg border bg-background p-5 shadow-sm">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Backend 当前不可用
              </div>
              <p className="text-sm text-muted-foreground">
                {backendStore.lastError || "Backend 已停止。"}
              </p>
              <Button size="sm" onClick={() => void retry()}>
                重新启动
              </Button>
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  );
});

export default App;
