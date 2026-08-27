import { parentPort } from "node:worker_threads";
import { Store } from "../core/db/store.js";
import { ingestAll } from "../core/ingest/engine.js";
import { dbPath } from "../core/paths.js";
import type { IngestWorkerRequest, IngestWorkerResponse } from "./ingest-protocol.js";

if (!parentPort) {
  throw new Error("ingest worker requires a parent port");
}

const port = parentPort;
const store = Store.open(dbPath());

port.on("message", (message: IngestWorkerRequest) => {
  switch (message.type) {
    case "ingest": {
      try {
        const report = ingestAll(store);
        const response: IngestWorkerResponse = { type: "result", id: message.id, report };
        port.postMessage(response);
      } catch (error) {
        const response: IngestWorkerResponse = {
          type: "error",
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        };
        port.postMessage(response);
      }
      return;
    }
    case "close":
      store.close();
      port.close();
      return;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
});
