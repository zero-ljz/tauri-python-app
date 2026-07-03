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
import { cn } from "@/lib/utils";

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
    id={`theme-${value}`}
    onClick={() => onChange(value)}
    className={cn(
      "flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors cursor-pointer",
      current === value
        ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10"
        : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
    )}
  >
    <Icon className={cn("h-5 w-5", current === value ? "text-[hsl(var(--primary))]" : "text-[hsl(var(--muted-foreground))]")} />
    <span className="text-xs font-medium">{label}</span>
  </button>
);

// 偏好设置模态对话框组件
export const PreferencesDialog = observer(() => {
  return (
    <Dialog open={appStore.preferencesOpen} onOpenChange={(open) => !open && appStore.closePreferences()}>
      <DialogContent className="max-w-md selectable">
        <DialogHeader>
          <DialogTitle>偏好设置</DialogTitle>
          <DialogDescription>自定义应用外观与行为</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* 主题选择区域 */}
          <div className="space-y-3">
            <Label className="text-sm font-semibold">主题模式</Label>
            <div className="grid grid-cols-3 gap-2">
              <ThemeOption value="light" icon={Sun} label="浅色模式" current={appStore.theme} onChange={(v) => appStore.setTheme(v)} />
              <ThemeOption value="dark" icon={Moon} label="深色模式" current={appStore.theme} onChange={(v) => appStore.setTheme(v)} />
              <ThemeOption value="system" icon={Monitor} label="跟随系统" current={appStore.theme} onChange={(v) => appStore.setTheme(v)} />
            </div>
          </div>

          <Separator />

          {/* 调试面板显示开关 */}
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
        </div>
      </DialogContent>
    </Dialog>
  );
});
