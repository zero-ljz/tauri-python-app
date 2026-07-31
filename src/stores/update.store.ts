import { invoke } from "@tauri-apps/api/core";
import { makeAutoObservable, runInAction } from "mobx";

export interface UpdaterStatus {
  configured: boolean;
  current_version: string;
}

export interface UpdateInfo {
  version: string;
  current_version: string;
  notes?: string | null;
  date?: string | null;
}

export type UpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "installing"
  | "error";

export class UpdateStore {
  state: UpdateState = "idle";
  currentVersion = "";
  available: UpdateInfo | null = null;
  lastError: string | null = null;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  async init(): Promise<void> {
    try {
      const status = await invoke<UpdaterStatus>("updater_status");
      runInAction(() => {
        this.currentVersion = status.current_version;
        this.state = status.configured ? "idle" : "disabled";
      });
      if (status.configured) {
        await this.check();
      }
    } catch (error) {
      this.setError(error);
    }
  }

  async check(): Promise<void> {
    this.state = "checking";
    this.lastError = null;
    try {
      const update = await invoke<UpdateInfo | null>("updater_check");
      runInAction(() => {
        this.available = update;
        this.state = update ? "available" : "up-to-date";
      });
    } catch (error) {
      this.setError(error);
    }
  }

  async install(): Promise<void> {
    if (!this.available) return;
    this.state = "installing";
    this.lastError = null;
    try {
      await invoke("updater_install");
    } catch (error) {
      this.setError(error);
    }
  }

  private setError(error: unknown): void {
    runInAction(() => {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
    });
  }
}

export const updateStore = new UpdateStore();
