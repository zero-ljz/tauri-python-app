import { observer } from "mobx-react-lite";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { appStore, type Theme } from "@/stores/app.store";
import { Monitor, Sun, Moon } from "lucide-react";
import { Download, FileJson, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { exportDiagnostics } from "@/lib/rpc";
import { rpcStore } from "@/stores/rpc.store";
import { updateStore } from "@/stores/update.store";
import { useState } from "react";

// 主题选择单个按钮项组件
const ThemeOption = ({
  value,
  icon: Icon,
  label,
  current,
  onChange,
}: {
  value: Theme;
  icon: React.ElementType;
  label: string;
  current: Theme;
  onChange: (v: Theme) => void;
}) => (
  <button
    type="button"
    id={`theme-${value}`}
    onClick={() => onChange(value)}
    className={cn(
      "flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors cursor-pointer",
      current === value
        ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10"
        : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]",
    )}
  >
    <Icon
      className={cn(
        "h-5 w-5",
        current === value ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]",
      )}
    />
    <span className="text-xs font-medium">{label}</span>
  </button>
);

// 偏好设置模态对话框组件
export const PreferencesDialog = observer(() => {
  const [diagnosticsMessage, setDiagnosticsMessage] = useState<string | null>(null);

  const handleDiagnosticsExport = async () => {
    try {
      const result = await exportDiagnostics({
        rpcEntries: rpcStore.entries,
        frontendLogs: rpcStore.logs,
      });
      setDiagnosticsMessage(`诊断文件已保存：${result.path}`);
    } catch (error) {
      setDiagnosticsMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Dialog
      open={appStore.preferencesOpen}
      onOpenChange={(open) => !open && appStore.closePreferences()}
    >
      <DialogContent className="flex max-w-md selectable flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 pr-12">
          <DialogTitle>偏好设置</DialogTitle>
          <DialogDescription>自定义应用外观与行为</DialogDescription>
        </DialogHeader>

        <div className="mr-1 mb-2 min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-4 [scrollbar-gutter:stable]">
          <div className="space-y-6 py-2">
            {/* 主题选择区域 */}
            <div className="space-y-3">
              <Label className="text-sm font-semibold">主题模式</Label>
              <div className="grid grid-cols-3 gap-2">
                <ThemeOption
                  value="light"
                  icon={Sun}
                  label="浅色模式"
                  current={appStore.theme}
                  onChange={(v) => appStore.setTheme(v)}
                />
                <ThemeOption
                  value="dark"
                  icon={Moon}
                  label="深色模式"
                  current={appStore.theme}
                  onChange={(v) => appStore.setTheme(v)}
                />
                <ThemeOption
                  value="system"
                  icon={Monitor}
                  label="跟随系统"
                  current={appStore.theme}
                  onChange={(v) => appStore.setTheme(v)}
                />
              </div>
            </div>

            <Separator />

            {/* 调试面板显示开关 */}
            {appStore.debugPanelAvailable && (
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="pref-debug-panel" className="text-sm font-medium">
                    IPC 调试面板
                  </Label>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    在右侧显示实时通信报文、Backend 日志与调试工具
                  </p>
                </div>
                <Switch
                  id="pref-debug-panel"
                  checked={appStore.debugPanelOpen}
                  onCheckedChange={() => appStore.toggleDebugPanel()}
                />
              </div>
            )}

            <Separator />

            <div className="space-y-3">
              <div>
                <Label className="text-sm font-semibold">应用更新</Label>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  当前版本 {updateStore.currentVersion || "未知"}
                  {updateStore.available ? `，可更新至 ${updateStore.available.version}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={updateStore.state === "disabled" || updateStore.state === "checking"}
                  onClick={() => void updateStore.check()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {updateStore.state === "checking" ? "检查中" : "检查更新"}
                </Button>
                {updateStore.available && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={updateStore.state === "installing"}
                    onClick={() => void updateStore.install()}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {updateStore.state === "installing" ? "安装中" : "安装并重启"}
                  </Button>
                )}
              </div>
              {updateStore.state === "disabled" && (
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  此构建未配置签名更新源。
                </p>
              )}
              {updateStore.lastError && (
                <p className="text-xs text-red-500">{updateStore.lastError}</p>
              )}
            </div>

            <Separator />

            <div className="space-y-3">
              <div>
                <Label className="text-sm font-semibold">诊断信息</Label>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  导出经过脱敏的状态和日志，便于提交故障报告。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleDiagnosticsExport()}
              >
                <FileJson className="h-3.5 w-3.5" />
                导出诊断文件
              </Button>
              {diagnosticsMessage && (
                <p className="break-all text-xs text-[hsl(var(--muted-foreground))]">
                  {diagnosticsMessage}
                </p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
