import fs from "node:fs";
import { Store } from "./db/store.js";
import { ingestAll, type IngestOptions } from "./ingest/engine.js";
import { liveSessions } from "./agents/query.js";
import { runImprove } from "./improve/pipeline.js";
import { applySuggestion, dismissSuggestion, undoSuggestion } from "./improve/apply.js";
import { dbPath, sidecarHome } from "./paths.js";
import { collectSetup } from "./setup/index.js";
import { fetchLiveUsage, liveUsageNotes } from "./usage/live.js";
import { buildUsageReport } from "./usage/report.js";
import type {
  ApplyResult,
  HealthReport,
  ImproveReport,
  IngestReport,
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
}
