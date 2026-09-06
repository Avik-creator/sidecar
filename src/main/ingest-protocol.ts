import type { ApplyResult, ImproveReport, IngestReport } from "../shared/types.js";

// Every job here writes to the database, so they all run on the worker thread.
export type WorkerJob =
  | { type: "ingest" }
  | { type: "runImprove" }
  | { type: "applySuggestion"; suggestionId: string }
  | { type: "undoSuggestion"; suggestionId: string }
  | { type: "dismissSuggestion"; suggestionId: string };

export type WorkerValue = IngestReport | ImproveReport | ApplyResult | null;

export type IngestWorkerRequest = (WorkerJob & { id: number }) | { type: "close" };

export type IngestWorkerResponse =
  | { type: "result"; id: number; value: WorkerValue }
  | { type: "error"; id: number; error: string };
