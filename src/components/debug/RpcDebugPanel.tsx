import { observer } from "mobx-react-lite";
import { useState } from "react";
import { rpcStore, type RpcEntry } from "@/stores/rpc.store";
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

// 报文日志记录面板
const LogPanel = observer(() => (
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

    const finish = rpcStore.trackRequest(method, parsedParams);
    try {
      const result = await rpcRequest(method, parsedParams);
      finish(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      finish(undefined, msg);
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
          className="selectable flex w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-xs font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))] resize-none"
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
          title="清空记录"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 选项卡划分：报文日志与手动请求 */}
      <Tabs defaultValue="log" className="flex flex-col flex-1 min-h-0">
        <div className="px-2 pt-1">
          <TabsList className="h-7 w-full">
            <TabsTrigger value="log" className="flex-1 text-xs">报文历史日志</TabsTrigger>
            <TabsTrigger value="send" className="flex-1 text-xs">模拟发送请求</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="log" className="flex-1 min-h-0 mt-0">
          <LogPanel />
        </TabsContent>
        <TabsContent value="send" className="flex-1 min-h-0 mt-0 overflow-y-auto">
          <SendPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
});
