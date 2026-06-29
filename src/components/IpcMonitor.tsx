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
      <button
        className="fixed bottom-4 right-4 z-[65] inline-flex h-10 items-center gap-2 rounded-full border border-[#374151] bg-[#1f2937] px-4 text-sm font-semibold text-[#f3f4f6] shadow-xl shadow-black/20 transition hover:-translate-y-0.5 hover:bg-[#374151]"
        onClick={() => store.toggleOpen()}
        title="Open IPC Monitor (Press ` or F12)"
        type="button"
      >
        <Bug size={16} />
        <span>IPC Monitor</span>
      </button>
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
    <section className="fixed inset-x-0 bottom-0 z-[60] flex h-[380px] flex-col border-t border-[#2d2d34] bg-[#18181c] font-mono text-[13px] text-[#cfd0d6] shadow-2xl shadow-black/30">
      <header className="flex h-9 shrink-0 select-none items-center justify-between border-b border-[#2d2d34] bg-[#202026] px-2">
        <div className="flex h-full gap-0.5">
          <MonitorTab
            active={store.activeTab === "packets"}
            icon={Network}
            label={`IPC Packets (${store.packets.length})`}
            onClick={() => store.setActiveTab("packets")}
          />
          <MonitorTab
            active={store.activeTab === "logs"}
            icon={Terminal}
            label={`Sidecar Logs (${store.logs.length})`}
            onClick={() => store.setActiveTab("logs")}
          />
        </div>

        <div className="flex min-w-0 items-center gap-3">
          <label className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 text-[#6b7280]" size={12} />
            <input
              className="h-6 w-[180px] rounded border border-[#2d2d34] bg-[#131316] py-1 pl-7 pr-2 text-xs text-[#e5e7eb] outline-none transition focus:border-[#0f766e]"
              placeholder={store.activeTab === "packets" ? "Filter packets..." : "Filter logs..."}
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

          <button
            className={monitorIconButtonClass}
            onClick={() => {
              if (store.activeTab === "packets") {
                store.clearPackets();
              } else {
                store.clearLogs();
              }
            }}
            title="Clear list"
            type="button"
          >
            <Trash2 size={13} />
          </button>

          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-[#9ca3af]">
            <input
              checked={store.autoScroll}
              className="m-0 accent-[#0f766e]"
              onChange={() => store.toggleAutoScroll()}
              type="checkbox"
            />
            <span>Auto Scroll</span>
          </label>

          <span className="text-[11px] text-[#4b5563]">Tip: Press ` to toggle</span>

          <button
            className={`${monitorIconButtonClass} hover:bg-red-500/10 hover:text-red-400`}
            onClick={() => store.setOpen(false)}
            title="Close"
            type="button"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 bg-[#18181c]">
        {store.activeTab === "packets" ? (
          <div className="grid h-full min-h-0 grid-cols-[55%_45%]">
            <div ref={listRef} className="min-h-0 overflow-y-auto border-r border-[#2d2d34]">
              <table className="w-full table-fixed border-collapse text-left">
                <thead>
                  <tr>
                    <th className={packetHeaderClass}>Time</th>
                    <th className={packetHeaderClass}>Dir</th>
                    <th className={packetHeaderClass}>Type</th>
                    <th className={packetHeaderClass}>Method/Event</th>
                    <th className={packetHeaderClass}>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPackets.length ? (
                    filteredPackets.map((packet) => {
                      const isSelected = store.selectedPacket?.id === packet.id;
                      return (
                        <tr
                          key={packet.id}
                          className={`cursor-pointer border-b border-[#1f1f26] transition hover:bg-[#23232b] ${
                            isSelected ? "bg-[#1e293b] text-[#38bdf8]" : packet.direction === "outgoing" ? "text-[#e5e7eb]" : "text-[#9ca3af]"
                          }`}
                          onClick={() => store.setSelectedPacket(packet)}
                        >
                          <td className="w-[90px] truncate px-2.5 py-1.5 text-[#6b7280]">{packet.timestamp}</td>
                          <td className="w-10 px-2.5 py-1.5 text-center">
                            {packet.direction === "outgoing" ? (
                              <ArrowUpRight className="inline text-[#3b82f6]" size={12} />
                            ) : (
                              <ArrowDownLeft className="inline text-[#10b981]" size={12} />
                            )}
                          </td>
                          <td className="w-[90px] px-2.5 py-1.5">
                            <PacketTypeBadge type={packet.type} />
                          </td>
                          <td className="truncate px-2.5 py-1.5">{packet.method}</td>
                          <td className="w-[50px] truncate px-2.5 py-1.5 text-[#6b7280]">{packet.rpcId ?? "-"}</td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td className="py-10 text-center text-[#4b5563]" colSpan={5}>
                        No packets recorded
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <PacketDetail />
          </div>
        ) : (
          <div ref={listRef} className="h-full min-h-0 overflow-y-auto p-2.5">
            <div className="grid gap-0.5">
              {filteredLogs.length ? (
                filteredLogs.map((log) => (
                  <div
                    key={log.id}
                    className={`flex gap-3 rounded-[2px] px-1 py-0.5 text-xs leading-5 hover:bg-white/[0.02] ${
                      log.stream === "lifecycle" ? "bg-sky-400/[0.04] text-[#38bdf8]" : "text-[#e5e7eb]"
                    }`}
                  >
                    <span className="shrink-0 text-[#4b5563]">{log.timestamp}</span>
                    <span
                      className={`w-20 shrink-0 font-semibold uppercase ${
                        log.stream === "stderr" ? "text-[#f59e0b]" : "text-[#0ea5e9]"
                      }`}
                    >
                      [{log.stream}]
                    </span>
                    <span className="flex-1 whitespace-pre-wrap break-all">{log.line}</span>
                  </div>
                ))
              ) : (
                <div className="py-10 text-center text-[#4b5563]">No logs recorded</div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
});

const monitorIconButtonClass =
  "grid h-7 w-7 place-items-center rounded border border-transparent bg-transparent text-[#9ca3af] transition hover:bg-[#2d2d34] hover:text-[#f3f4f6]";
const packetHeaderClass =
  "sticky top-0 z-10 border-b border-[#2d2d34] bg-[#1e1e24] px-2.5 py-1.5 text-xs font-semibold uppercase text-[#9ca3af]";

function MonitorTab({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof Network;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex h-full items-center gap-1.5 border-b-2 px-3.5 text-[13px] transition ${
        active
          ? "border-[#2dd4bf] bg-[#18181c] text-[#2dd4bf]"
          : "border-transparent bg-transparent text-[#9ca3af] hover:bg-white/[0.02] hover:text-[#e5e7eb]"
      }`}
      onClick={onClick}
      type="button"
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}

function PacketDetail() {
  const selectedPacket = ipcMonitorStore.selectedPacket;

  if (!selectedPacket) {
    return (
      <div className="grid h-full min-h-0 place-items-center bg-[#1c1c22] text-[#4b5563]">
        <div className="grid justify-items-center gap-2.5">
          <Info size={24} />
          <p className="m-0">Select a packet to view details</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[#1c1c22] p-3">
      <div className="mb-2.5 flex items-center justify-between border-b border-[#2d2d34] pb-2">
        <h4 className="m-0 text-sm font-semibold text-[#e5e7eb]">Packet Details</h4>
        <PacketTypeBadge type={selectedPacket.type} />
      </div>

      <div className="mb-3 grid gap-1 rounded bg-[#141418] p-2 text-xs text-[#9ca3af]">
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

      <div className="min-h-0 flex-1 overflow-auto rounded border border-[#232328] bg-[#131316]">
        <pre className="m-0 whitespace-pre-wrap break-all p-2.5 text-[12px] leading-5">
          <code dangerouslySetInnerHTML={{ __html: highlightJson(selectedPacket.payload) }} />
        </pre>
      </div>
    </div>
  );
}

function PacketTypeBadge({ type }: { type: "request" | "response" | "notification" }) {
  const className = {
    request: "bg-blue-500/15 text-blue-300",
    response: "bg-emerald-500/15 text-emerald-300",
    notification: "bg-amber-500/15 text-amber-300",
  }[type];

  return (
    <span className={`inline-flex rounded-[3px] px-1.5 py-0.5 text-[10px] font-bold uppercase ${className}`}>
      {type}
    </span>
  );
}

export default IpcMonitor;
