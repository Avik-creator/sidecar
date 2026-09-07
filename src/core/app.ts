import fs from "node:fs";
import { Store } from "./db/store.js";
import { ingestAll, type IngestOptions } from "./ingest/engine.js";
import { liveSessions } from "./agents/query.js";
import { runImprove } from "./improve/pipeline.js";
import { applySuggestion, dismissSuggestion, undoSuggestion } from "./improve/apply.js";
import { dbPath, sidecarHome } from "./paths.js";
import { collectSetup } from "./setup/index.js";
import { readSettings, writeSettings } from "./settings.js";
import {
  ensureHooks as autoInstallHooks,
  hooksStatus as readHooksStatus,
  installHooks as writeHooks,
  uninstallHooks as removeHooks,
} from "./hooks/install.js";
import { fetchLiveUsage, liveUsageNotes } from "./usage/live.js";
import { buildUsageReport } from "./usage/report.js";
import type {
  ApplyResult,
  HealthReport,
  HookStatus,
  ImproveReport,
  IngestReport,
  Settings,
  SidecarApi,
  UsageReport,
} from "../shared/types.js";

export class SidecarService implements SidecarApi {
  readonly store: Store;
  readonly dbFile: string;

  constructor(store: Store, dbFile: string) {
    this.store = store;
    this.dbFile = dbFile;
  }

  static open(filePath = dbPath()): SidecarService {
    fs.mkdirSync(sidecarHome(), { recursive: true });
    return new SidecarService(Store.open(filePath), filePath);
  }

  close(): void {
    this.store.close();
  }

  async health(): Promise<HealthReport> {
    const counts = this.store.counts();
    return {
      dbPath: this.dbFile,
      ...counts,
      integrations: this.store.listHealth(),
    };
  }

  async ingest(options: IngestOptions = {}): Promise<IngestReport> {
    return ingestAll(this.store, options);
  }

  async usage(days = 30): Promise<UsageReport> {
    const report = buildUsageReport(this.store, days);
    if (process.env.SIDECAR_LIVE_USAGE === "0") {
      return report;
    }
    try {
      const live = await fetchLiveUsage();
      return {
        ...report,
        live,
        notes: [...report.notes, ...liveUsageNotes(live)],
      };
    } catch (error) {
      return {
        ...report,
        notes: [
          ...report.notes,
          `Live usage probe failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  async sessions() {
    return liveSessions(this.store);
  }

  async setup() {
    return collectSetup(this.store);
  }

  async candidates(limit = 200) {
    return this.store.listCandidates(limit);
  }

  async clusters() {
    return this.store.listClusters();
  }

  async suggestions() {
    return this.store.listSuggestions();
  }

  async runImprove(): Promise<ImproveReport> {
    return runImprove(this.store);
  }

  async applySuggestion(id: string): Promise<ApplyResult> {
    return applySuggestion(this.store, id);
  }

  async undoSuggestion(id: string): Promise<ApplyResult> {
    return undoSuggestion(this.store, id);
  }

  async dismissSuggestion(id: string): Promise<void> {
    dismissSuggestion(this.store, id);
  }

  async settings(): Promise<Settings> {
    return readSettings();
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return writeSettings(patch);
  }

  async hooksStatus(): Promise<HookStatus[]> {
    return this.withLastEvent(readHooksStatus());
  }

  // Runs at launch: without hooks Sidecar sees nothing, so it repairs its own wiring.
  async ensureHooks(): Promise<HookStatus[]> {
    if (!readSettings().hooksAutoInstall) {
      return this.withLastEvent(readHooksStatus());
    }
    return this.withLastEvent(autoInstallHooks());
  }

  async installHooks(): Promise<HookStatus[]> {
    writeSettings({ hooksAutoInstall: true });
    return this.withLastEvent(writeHooks());
  }

  // Removing by hand also switches the automatic install off, so it stays removed.
  async uninstallHooks(): Promise<HookStatus[]> {
    writeSettings({ hooksAutoInstall: false });
    return this.withLastEvent(removeHooks());
  }

  // An installed hook that has never produced an event is the failure mode worth showing.
  private withLastEvent(statuses: HookStatus[]): HookStatus[] {
    const seen = this.store.lastHookEventAt();
    return statuses.map((status) => ({ ...status, lastEventAt: seen[status.harness] ?? null }));
  }
}
