import type { IngestReport } from "../shared/types.js";

export type IngestWorkerRequest =
  | { type: "ingest"; id: number }
  | { type: "close" };

export type IngestWorkerResponse =
  | { type: "result"; id: number; report: IngestReport }
  | { type: "error"; id: number; error: string };
