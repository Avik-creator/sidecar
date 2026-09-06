import { parentPort } from "node:worker_threads";
import { Store } from "../core/db/store.js";
import { ingestAll } from "../core/ingest/engine.js";
import { runImprove } from "../core/improve/pipeline.js";
import { applySuggestion, dismissSuggestion, undoSuggestion } from "../core/improve/apply.js";
import { dbPath } from "../core/paths.js";
import type {
  IngestWorkerRequest,
  IngestWorkerResponse,
  WorkerJob,
  WorkerValue,
} from "./ingest-protocol.js";

if (!parentPort) {
  throw new Error("ingest worker requires a parent port");
}

const port = parentPort;
const store = Store.open(dbPath());

port.on("message", (message: IngestWorkerRequest) => {
  if (message.type === "close") {
    store.close();
    port.close();
    return;
  }
  try {
    const response: IngestWorkerResponse = { type: "result", id: message.id, value: runJob(message) };
    port.postMessage(response);
  } catch (error) {
    const response: IngestWorkerResponse = {
      type: "error",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});

function runJob(job: WorkerJob): WorkerValue {
  switch (job.type) {
    case "ingest":
      return ingestAll(store);
    case "runImprove":
      return runImprove(store);
    case "applySuggestion":
      return applySuggestion(store, job.suggestionId);
    case "undoSuggestion":
      return undoSuggestion(store, job.suggestionId);
    case "dismissSuggestion":
      dismissSuggestion(store, job.suggestionId);
      return null;
    default: {
      const exhaustive: never = job;
      return exhaustive;
    }
  }
}
