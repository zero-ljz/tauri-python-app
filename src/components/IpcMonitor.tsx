import { useEffect, useRef } from "react";
import { observer } from "mobx-react-lite";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bug,
  Info,
  Network,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "../lib/utils";
import { ipcMonitorStore } from "../stores/ipcMonitorStore";

function highlightJson(jsonObj: unknown): string {
  if (jsonObj === null || jsonObj === undefined) {
    return "";
  }

  const jsonStr = JSON.stringify(jsonObj, null, 2);
  return jsonStr.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "json-val-number";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-val-string";
      } else if (/true|false/.test(match)) {
        cls = "json-val-bool";
      } else if (/null/.test(match)) {
        cls = "json-val-null";
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

export const IpcMonitor = observer(() => {
  const store = ipcMonitorStore;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void store.initialize();
    return () => store.dispose();
  }, [store]);

  useEffect(() => {
    if (store.autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [store.packets.length, store.logs.length, store.activeTab, store.autoScroll]);

  if (!store.isOpen) {
    return (
      <Button
        className="fixed bottom-4 right-4 z-[65] h-10 rounded-full px-4 shadow-lg"
        onClick={() => store.toggleOpen()}
        title="打开 IPC 调试面板"
        type="button"
      >
        <Bug size={16} />
        <span>IPC 调试</span>
      </Button>
    );
  }

  const filteredPackets = store.packets.filter((packet) => {
    if (!store.packetFilter) {
      return true;
    }
    const filter = store.packetFilter.toLowerCase();
    return (
      packet.method.toLowerCase().includes(filter) ||
      packet.type.toLowerCase().includes(filter) ||
      packet.direction.toLowerCase().includes(filter) ||
      JSON.stringify(packet.payload).toLowerCase().includes(filter)
    );
  });

  const filteredLogs = store.logs.filter((log) => {
    if (!store.logFilter) {
      return true;
    }
    const filter = store.logFilter.toLowerCase();
    return log.line.toLowerCase().includes(filter) || log.stream.toLowerCase().includes(filter);
  });

  return (
    <Tabs
      value={store.activeTab}
      onValueChange={(value) => store.setActiveTab(value as "packets" | "logs")}
      className="fixed inset-x-0 bottom-0 z-[60] flex h-[380px] flex-col gap-0 border-t bg-background font-mono text-[13px] shadow-lg"
    >
      <header className="flex h-12 shrink-0 select-none items-center justify-between border-b px-3">
        <TabsList>
          <TabsTrigger value="packets" className="gap-2">
            <Network size={14} />
            IPC Packets ({store.packets.length})
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-2">
            <Terminal size={14} />
            Sidecar Logs ({store.logs.length})
          </TabsTrigger>
        </TabsList>

        <div className="flex min-w-0 items-center gap-2">
          <label className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 text-muted-foreground" size={13} />
            <Input
              className="h-8 w-[min(220px,28vw)] pl-7 text-xs"
              placeholder={store.activeTab === "packets" ? "过滤 packets..." : "过滤 logs..."}
              value={store.activeTab === "packets" ? store.packetFilter : store.logFilter}
              onChange={(event) => {
                if (store.activeTab === "packets") {
                  store.setPacketFilter(event.currentTarget.value);
                } else {
                  store.setLogFilter(event.currentTarget.value);
                }
              }}
            />
          </label>

          <Button
            aria-label="清空列表"
            onClick={() => {
              if (store.activeTab === "packets") {
                store.clearPackets();
              } else {
                store.clearLogs();
              }
            }}
            size="icon"
            title="清空列表"
            type="button"
            variant="ghost"
          >
            <Trash2 size={14} />
          </Button>

          <label className="hidden cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground sm:flex">
            <Switch checked={store.autoScroll} onCheckedChange={() => store.toggleAutoScroll()} />
            <span>自动滚动</span>
          </label>

          <Button
            aria-label="关闭"
            onClick={() => store.setOpen(false)}
            size="icon"
            title="关闭"
            type="button"
            variant="ghost"
          >
            <X size={15} />
          </Button>
        </div>
      </header>

      <TabsContent value="packets" className="min-h-0 flex-1">
        <div className="grid h-full min-h-0 md:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
          <div ref={listRef} className="min-h-0 overflow-y-auto border-r">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[90px]">Time</TableHead>
                  <TableHead className="w-10 text-center">Dir</TableHead>
                  <TableHead className="w-[90px]">Type</TableHead>
                  <TableHead>Method/Event</TableHead>
                  <TableHead className="w-[50px]">ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPackets.length ? (
                  filteredPackets.map((packet) => {
                    const isSelected = store.selectedPacket?.id === packet.id;
                    return (
                      <TableRow
                        key={packet.id}
                        data-state={isSelected ? "selected" : undefined}
                        className="cursor-pointer"
                        onClick={() => store.setSelectedPacket(packet)}
                      >
                        <TableCell className="truncate text-muted-foreground">
                          {packet.timestamp}
                        </TableCell>
                        <TableCell className="text-center text-muted-foreground">
                          {packet.direction === "outgoing" ? (
                            <ArrowUpRight className="inline" size={12} />
                          ) : (
                            <ArrowDownLeft className="inline" size={12} />
                          )}
                        </TableCell>
                        <TableCell>
                          <PacketTypeBadge type={packet.type} />
                        </TableCell>
                        <TableCell className="truncate">{packet.method}</TableCell>
                        <TableCell className="truncate text-muted-foreground">
                          {packet.rpcId ?? "-"}
                        </TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell className="py-10 text-center text-muted-foreground" colSpan={5}>
                      暂无 IPC packets
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <PacketDetail />
        </div>
      </TabsContent>

      <TabsContent value="logs" className="min-h-0 flex-1">
        <div ref={listRef} className="h-full min-h-0 overflow-y-auto p-3">
          <div className="grid gap-1">
            {filteredLogs.length ? (
              filteredLogs.map((log) => (
                <div
                  key={log.id}
                  className={cn(
                    "flex gap-3 rounded-md px-2 py-1 text-xs leading-5 hover:bg-muted",
                    log.stream === "lifecycle" && "bg-muted",
                  )}
                >
                  <span className="shrink-0 text-muted-foreground">{log.timestamp}</span>
                  <span className="w-20 shrink-0 font-semibold uppercase text-muted-foreground">
                    [{log.stream}]
                  </span>
                  <span className="flex-1 whitespace-pre-wrap break-all">{log.line}</span>
                </div>
              ))
            ) : (
              <div className="py-10 text-center text-muted-foreground">暂无 sidecar logs</div>
            )}
          </div>
        </div>
      </TabsContent>
    </Tabs>
  );
});

function PacketDetail() {
  const selectedPacket = ipcMonitorStore.selectedPacket;

  if (!selectedPacket) {
    return (
      <div className="grid h-full min-h-0 place-items-center bg-muted text-muted-foreground">
        <div className="grid justify-items-center gap-2.5">
          <Info size={24} />
          <p className="m-0">选择一个 packet 查看详情</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-muted p-3">
      <div className="mb-3 flex items-center justify-between border-b pb-2">
        <h4 className="m-0 text-sm font-semibold">Packet Details</h4>
        <PacketTypeBadge type={selectedPacket.type} />
      </div>

      <div className="mb-3 grid gap-1 rounded-md border bg-background p-2 text-xs text-muted-foreground">
        <div>
          <strong>Direction:</strong> {selectedPacket.direction}
        </div>
        <div>
          <strong>Time:</strong> {selectedPacket.timestamp}
        </div>
        <div>
          <strong>JSON-RPC ID:</strong> {selectedPacket.rpcId ?? "None"}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
        <pre className="m-0 whitespace-pre-wrap break-all p-2.5 text-[12px] leading-5">
          <code dangerouslySetInnerHTML={{ __html: highlightJson(selectedPacket.payload) }} />
        </pre>
      </div>
    </div>
  );
}

function PacketTypeBadge({ type }: { type: "request" | "response" | "notification" }) {
  const variant = {
    request: "default",
    response: "secondary",
    notification: "outline",
  } as const;

  return (
    <Badge className="rounded px-1.5 py-0 text-[10px] font-bold uppercase" variant={variant[type]}>
      {type}
    </Badge>
  );
}

export default IpcMonitor;
