import { useEffect, useRef } from "react";
import { observer } from "mobx-react-lite";
import {
  X,
  Trash2,
  Terminal,
  Network,
  ArrowUpRight,
  ArrowDownLeft,
  Search,
  Info,
  Bug,
} from "lucide-react";
import { ipcMonitorStore } from "../stores/ipcMonitorStore";
import "./IpcMonitor.css";

// Simple JSON highlighting helper
function highlightJson(jsonObj: any): string {
  if (jsonObj === null || jsonObj === undefined) {
    return "";
  }
  const jsonStr = JSON.stringify(jsonObj, null, 2);
  return jsonStr.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "json-val-number";
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = "json-key";
        } else {
          cls = "json-val-string";
        }
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

  // Initialize the listeners
  useEffect(() => {
    void store.initialize();
    return () => store.dispose();
  }, [store]);

  // Auto-scroll logic
  useEffect(() => {
    if (store.autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [store.packets.length, store.logs.length, store.activeTab, store.autoScroll]);

  if (!store.isOpen) {
    // Return a floating toggle badge at the bottom-right so the user knows they can open it
    return (
      <button
        className="ipc-monitor-floating-toggle"
        onClick={() => store.toggleOpen()}
        title="Open IPC Monitor (Press ` or F12)"
      >
        <Bug size={16} />
        <span>IPC Monitor</span>
      </button>
    );
  }

  // Filter lists based on search criteria
  const filteredPackets = store.packets.filter((p) => {
    if (!store.packetFilter) {
      return true;
    }
    const filter = store.packetFilter.toLowerCase();
    return (
      p.method.toLowerCase().includes(filter) ||
      p.type.toLowerCase().includes(filter) ||
      p.direction.toLowerCase().includes(filter) ||
      JSON.stringify(p.payload).toLowerCase().includes(filter)
    );
  });

  const filteredLogs = store.logs.filter((l) => {
    if (!store.logFilter) {
      return true;
    }
    const filter = store.logFilter.toLowerCase();
    return l.line.toLowerCase().includes(filter) || l.stream.toLowerCase().includes(filter);
  });

  return (
    <section className={`ipc-monitor-panel ${store.isOpen ? "is-open" : ""}`}>
      {/* Header / Toolbar */}
      <header className="ipc-monitor-header">
        <div className="ipc-monitor-header__tabs">
          <button
            className={`ipc-monitor-tab ${store.activeTab === "packets" ? "is-active" : ""}`}
            onClick={() => store.setActiveTab("packets")}
          >
            <Network size={14} />
            <span>IPC Packets ({store.packets.length})</span>
          </button>
          <button
            className={`ipc-monitor-tab ${store.activeTab === "logs" ? "is-active" : ""}`}
            onClick={() => store.setActiveTab("logs")}
          >
            <Terminal size={14} />
            <span>Sidecar Logs ({store.logs.length})</span>
          </button>
        </div>

        {/* Filter & Actions Bar */}
        <div className="ipc-monitor-header__actions">
          {store.activeTab === "packets" ? (
            <div className="ipc-monitor-search-wrapper">
              <Search size={12} className="search-icon" />
              <input
                type="text"
                placeholder="Filter packets..."
                value={store.packetFilter}
                onChange={(e) => store.setPacketFilter(e.target.value)}
              />
            </div>
          ) : (
            <div className="ipc-monitor-search-wrapper">
              <Search size={12} className="search-icon" />
              <input
                type="text"
                placeholder="Filter logs..."
                value={store.logFilter}
                onChange={(e) => store.setLogFilter(e.target.value)}
              />
            </div>
          )}

          <button
            className="ipc-monitor-action-btn"
            onClick={() => {
              if (store.activeTab === "packets") {
                store.clearPackets();
              } else {
                store.clearLogs();
              }
            }}
            title="Clear list"
          >
            <Trash2 size={13} />
          </button>

          <label className="ipc-monitor-checkbox-label">
            <input
              type="checkbox"
              checked={store.autoScroll}
              onChange={() => store.toggleAutoScroll()}
            />
            <span>Auto Scroll</span>
          </label>

          <span className="ipc-monitor-tip">Tip: Press ` to toggle</span>

          <button className="ipc-monitor-close-btn" onClick={() => store.setOpen(false)}>
            <X size={15} />
          </button>
        </div>
      </header>

      {/* Main View Area */}
      <div className="ipc-monitor-content">
        {store.activeTab === "packets" ? (
          <div className="ipc-monitor-packets-layout">
            {/* Packets List */}
            <div className="packets-list-pane" ref={listRef}>
              <table className="packets-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Dir</th>
                    <th>Type</th>
                    <th>Method/Event</th>
                    <th>ID</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPackets.length ? (
                    filteredPackets.map((packet) => {
                      const isSelected = store.selectedPacket?.id === packet.id;
                      return (
                        <tr
                          key={packet.id}
                          className={`packet-row is-${packet.direction} is-${packet.type} ${isSelected ? "is-selected" : ""}`}
                          onClick={() => store.setSelectedPacket(packet)}
                        >
                          <td className="col-time">{packet.timestamp}</td>
                          <td className="col-dir">
                            {packet.direction === "outgoing" ? (
                              <ArrowUpRight size={12} className="dir-out" />
                            ) : (
                              <ArrowDownLeft size={12} className="dir-in" />
                            )}
                          </td>
                          <td className="col-type">
                            <span className={`type-badge badge-${packet.type}`}>
                              {packet.type}
                            </span>
                          </td>
                          <td className="col-method">{packet.method}</td>
                          <td className="col-id">{packet.rpcId ?? "-"}</td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} className="no-data">
                        No packets recorded
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Packet Detail Pane */}
            <div className="packet-detail-pane">
              {store.selectedPacket ? (
                <div className="detail-container">
                  <div className="detail-header">
                    <h4>Packet Details</h4>
                    <span className={`detail-type-tag badge-${store.selectedPacket.type}`}>
                      {store.selectedPacket.type}
                    </span>
                  </div>
                  <div className="detail-meta">
                    <div>
                      <strong>Direction:</strong> {store.selectedPacket.direction}
                    </div>
                    <div>
                      <strong>Time:</strong> {store.selectedPacket.timestamp}
                    </div>
                    <div>
                      <strong>JSON-RPC ID:</strong> {store.selectedPacket.rpcId ?? "None"}
                    </div>
                  </div>
                  <div className="detail-body">
                    <pre className="json-pre">
                      <code
                        dangerouslySetInnerHTML={{
                          __html: highlightJson(store.selectedPacket.payload),
                        }}
                      />
                    </pre>
                  </div>
                </div>
              ) : (
                <div className="detail-empty-state">
                  <Info size={24} />
                  <p>Select a packet to view details</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Logs Pane */
          <div className="logs-pane" ref={listRef}>
            <div className="logs-list">
              {filteredLogs.length ? (
                filteredLogs.map((log) => (
                  <div key={log.id} className={`log-line stream-${log.stream}`}>
                    <span className="log-line__time">{log.timestamp}</span>
                    <span className="log-line__stream">[{log.stream}]</span>
                    <span className="log-line__text">{log.line}</span>
                  </div>
                ))
              ) : (
                <div className="no-data">No logs recorded</div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
});
export default IpcMonitor;
