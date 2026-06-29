import { makeAutoObservable, runInAction } from "mobx";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface IpcPacket {
  id: string;
  timestamp: string;
  direction: "incoming" | "outgoing";
  type: "request" | "response" | "notification";
  method: string;
  rpcId?: string | number;
  payload: any;
}

export interface SidecarLog {
  id: string;
  timestamp: string;
  stream: "stderr" | "lifecycle";
  line: string;
}

class IpcMonitorStore {
  isOpen = false;
  packets: IpcPacket[] = [];
  logs: SidecarLog[] = [];
  selectedPacket: IpcPacket | null = null;
  activeTab: "packets" | "logs" = "packets";
  packetFilter = "";
  logFilter = "";
  autoScroll = true;

  private unlistenFns: UnlistenFn[] = [];
  private initialized = false;

  constructor() {
    makeAutoObservable(this);
  }

  async initialize() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Listen to packet events
    const unlistenPacket = await listen<{ direction: "incoming" | "outgoing"; payload: any }>(
      "sidecar://packet",
      (event) => {
        this.addPacket(event.payload.direction, event.payload.payload);
      },
    );

    // Listen to log events
    const unlistenLog = await listen<{ stream: string; line: string }>(
      "sidecar://log",
      (event) => {
        this.addLog(event.payload.stream as any, event.payload.line);
      },
    );

    // Listen to lifecycle events
    const unlistenLifecycle = await listen<{ state: string; detail: any }>(
      "sidecar://lifecycle",
      (event) => {
        this.addLog(
          "lifecycle",
          `[${event.payload.state.toUpperCase()}] ${JSON.stringify(event.payload.detail)}`,
        );
      },
    );

    runInAction(() => {
      this.unlistenFns = [unlistenPacket, unlistenLog, unlistenLifecycle];
    });

    // Add keyboard listener
    window.addEventListener("keydown", this.handleKeyDown);
  }

  dispose() {
    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];
    window.removeEventListener("keydown", this.handleKeyDown);
    this.initialized = false;
  }

  toggleOpen() {
    this.isOpen = !this.isOpen;
  }

  setOpen(open: boolean) {
    this.isOpen = open;
  }

  setActiveTab(tab: "packets" | "logs") {
    this.activeTab = tab;
  }

  setSelectedPacket(packet: IpcPacket | null) {
    this.selectedPacket = packet;
  }

  setPacketFilter(filter: string) {
    this.packetFilter = filter;
  }

  setLogFilter(filter: string) {
    this.logFilter = filter;
  }

  toggleAutoScroll() {
    this.autoScroll = !this.autoScroll;
  }

  clearPackets() {
    this.packets = [];
    this.selectedPacket = null;
  }

  clearLogs() {
    this.logs = [];
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    // Toggle with F12 or Ctrl+Shift+I or Backtick (`)
    if (
      event.key === "F12" ||
      (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "i") ||
      event.key === "`"
    ) {
      event.preventDefault();
      runInAction(() => {
        this.toggleOpen();
      });
    }
  };

  private addPacket(direction: "incoming" | "outgoing", rawPayload: any) {
    const timestamp = new Date().toLocaleTimeString();
    const id = Math.random().toString(36).substring(2, 9);

    let type: "request" | "response" | "notification" = "request";
    let method = "-";
    const rpcId = rawPayload?.id;

    if (rawPayload && typeof rawPayload === "object") {
      if ("method" in rawPayload) {
        method = rawPayload.method;
        type = "id" in rawPayload ? "request" : "notification";
      } else if ("result" in rawPayload || "error" in rawPayload) {
        type = "response";
        // Attempt to match with previous requests to get method name
        if (rpcId !== undefined) {
          const req = this.packets.find((p) => p.type === "request" && p.rpcId === rpcId);
          if (req) {
            method = `${req.method} (Response)`;
          } else {
            method = "Response";
          }
        }
      }
    }

    runInAction(() => {
      this.packets.push({
        id,
        timestamp,
        direction,
        type,
        method,
        rpcId,
        payload: rawPayload,
      });

      // Cap size to 200 packets
      if (this.packets.length > 200) {
        this.packets.shift();
      }
    });
  }

  private addLog(stream: "stderr" | "lifecycle", line: string) {
    const timestamp = new Date().toLocaleTimeString();
    const id = Math.random().toString(36).substring(2, 9);

    runInAction(() => {
      this.logs.push({
        id,
        timestamp,
        stream,
        line,
      });

      // Cap size to 200 logs
      if (this.logs.length > 200) {
        this.logs.shift();
      }
    });
  }
}

export const ipcMonitorStore = new IpcMonitorStore();
