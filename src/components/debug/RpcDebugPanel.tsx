import { observer } from "mobx-react-lite";
import { useState } from "react";
import { rpcStore, type RpcEntry, type SidecarLogEntry } from "@/stores/rpc.store";
import { rpcRequest } from "@/lib/tauri-rpc";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trash2, Send, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// 各类报文方向的专属高亮颜色
const directionColors: Record<RpcEntry["direction"], string> = {
  request: "text-blue-500",
  response: "text-emerald-500",
  notification: "text-violet-500",
  error: "text-red-500",
};

// 报文缩写标识
const directionLabels: Record<RpcEntry["direction"], string> = {
  request: "REQ",
  response: "RES",
  notification: "NTF",
  error: "ERR",
};

const logLevelColors: Record<SidecarLogEntry["level"], string> = {
  debug: "text-slate-500",
  info: "text-sky-500",
  warning: "text-amber-500",
  error: "text-red-500",
};

// 单行报文条目组件（支持展开折叠展示参数/结果明细）
const EntryRow = observer(({ entry }: { entry: RpcEntry }) => {
  const [expanded, setExpanded] = useState(false);
  const color = directionColors[entry.direction];
  const label = directionLabels[entry.direction];
  const time = new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false });

  const payload = entry.result ?? entry.params ?? entry.error;

  return (
    <div className="border-b border-[hsl(var(--border))] last:border-0">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[hsl(var(--accent))] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
        )}
        <span className={cn("text-xs font-mono font-bold w-8 shrink-0", color)}>{label}</span>
        <span className="flex-1 text-xs font-mono truncate">{entry.method ?? "(未知方法)"}</span>
        {entry.duration != null && (
          <span className="text-xs text-[hsl(var(--muted-foreground))] font-mono">{entry.duration}ms</span>
        )}
        <span className="text-xs text-[hsl(var(--muted-foreground))] font-mono shrink-0">{time}</span>
      </button>
      {expanded && payload !== undefined && (
        <div className="px-3 pb-2">
          <pre className="text-xs font-mono bg-[hsl(var(--muted))] rounded p-2 overflow-x-auto selectable whitespace-pre-wrap break-all">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
});

// 报文历史面板
const MessagePanel = observer(() => (
  <ScrollArea className="h-full">
    <div className="divide-y divide-[hsl(var(--border))]">
      {rpcStore.entries.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-sm text-[hsl(var(--muted-foreground))]">
          暂无报文历史
        </div>
      ) : (
        rpcStore.entries.map((entry) => <EntryRow key={entry.id} entry={entry} />)
      )}
    </div>
  </ScrollArea>
));

const SidecarLogRow = ({ entry }: { entry: SidecarLogEntry }) => {
  const time = new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false });

  return (
    <div className="border-b border-[hsl(var(--border))] px-3 py-2 last:border-0">
      <div className="flex items-start gap-2 text-xs">
        <span className="w-16 shrink-0 font-mono text-[hsl(var(--muted-foreground))]">{time}</span>
        <span className={cn("w-14 shrink-0 font-mono font-bold uppercase", logLevelColors[entry.level])}>
          {entry.level}
        </span>
        <span className="w-20 shrink-0 truncate font-mono text-[hsl(var(--muted-foreground))]">
          {entry.source}/{entry.stream}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[hsl(var(--foreground))]">
          {entry.message}
        </span>
      </div>
      {entry.context && (
        <pre className="mt-2 overflow-x-auto rounded bg-[hsl(var(--muted))] p-2 text-xs font-mono whitespace-pre-wrap break-all">
          {JSON.stringify(entry.context, null, 2)}
        </pre>
      )}
    </div>
  );
};

const SidecarLogsPanel = observer(() => (
  <ScrollArea className="h-full">
    <div className="divide-y divide-[hsl(var(--border))]">
      {rpcStore.logs.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          暂无 Sidecar 日志
        </div>
      ) : (
        rpcStore.logs.map((entry) => <SidecarLogRow key={entry.id} entry={entry} />)
      )}
    </div>
  </ScrollArea>
));

// 手动发送请求调试面板
const SendPanel = observer(() => {
  const [method, setMethod] = useState("echo");
  const [params, setParams] = useState('{"message":"hello"}');
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // 触发手动发送 RPC
  const handleSend = async () => {
    setLoading(true);
    setLastError(null);
    let parsedParams: unknown = null;
    try {
      parsedParams = params.trim() ? JSON.parse(params) : null;
    } catch {
      setLastError("参数 JSON 格式解析错误");
      setLoading(false);
      return;
    }

    try {
      await rpcRequest(method, parsedParams);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="space-y-1">
        <Label htmlFor="rpc-method" className="text-xs">调用方法名</Label>
        <Input
          id="rpc-method"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          placeholder="例如 echo"
          className="font-mono text-xs h-8"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rpc-params" className="text-xs">请求参数负载 (JSON 格式)</Label>
        <textarea
          id="rpc-params"
          value={params}
          onChange={(e) => setParams(e.target.value)}
          rows={4}
          className="selectable flex w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      {lastError && (
        <p className="text-xs text-red-500">{lastError}</p>
      )}
      <Button
        id="rpc-send"
        onClick={handleSend}
        disabled={loading || !method}
        size="sm"
        className="gap-2"
      >
        <Send className="h-3.5 w-3.5" />
        {loading ? "正在发送..." : "发送请求"}
      </Button>
    </div>
  );
});

// IPC 报文及协议交互调试控制面板组件
export const RpcDebugPanel = observer(() => {
  return (
    <div className="flex flex-col h-full border-l border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      {/* 头部区 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[hsl(var(--border))]">
        <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
          IPC 报文调试
        </span>
        <Button
          id="rpc-clear"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => rpcStore.clear()}
          title="清空报文和日志"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 选项卡划分：报文、Sidecar 日志与手动请求 */}
      <Tabs defaultValue="messages" className="flex flex-col flex-1 min-h-0">
        <div className="px-2 pt-1">
          <TabsList className="grid h-7 w-full grid-cols-3 rounded-md p-0.5">
            <TabsTrigger value="messages" className="h-6 rounded px-2 py-0 text-xs leading-none">报文</TabsTrigger>
            <TabsTrigger value="logs" className="h-6 rounded px-2 py-0 text-xs leading-none">日志</TabsTrigger>
            <TabsTrigger value="send" className="h-6 rounded px-2 py-0 text-xs leading-none">请求</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="messages" className="flex-1 min-h-0 mt-0">
          <MessagePanel />
        </TabsContent>
        <TabsContent value="logs" className="flex-1 min-h-0 mt-0">
          <SidecarLogsPanel />
        </TabsContent>
        <TabsContent value="send" className="flex-1 min-h-0 mt-0 overflow-y-auto">
          <SendPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
});
