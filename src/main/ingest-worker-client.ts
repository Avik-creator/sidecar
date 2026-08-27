import { Worker } from "node:worker_threads";
import type { IngestReport } from "../shared/types.js";
import type { IngestWorkerRequest, IngestWorkerResponse } from "./ingest-protocol.js";

interface PendingIngest {
  resolve: (report: IngestReport) => void;
  reject: (error: Error) => void;
}

export class IngestWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingIngest>();

  constructor(private readonly workerUrl: URL) {}

  ingest(): Promise<IngestReport> {
    const worker = this.getWorker();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: IngestWorkerRequest = { type: "ingest", id };
      worker.postMessage(request);
    });
  }

  close(): void {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    this.worker = null;
    const request: IngestWorkerRequest = { type: "close" };
    worker.postMessage(request);
    this.rejectPending(new Error("ingest worker closed"));
  }

  private getWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = new Worker(this.workerUrl);
    this.worker = worker;
    worker.on("message", (message: IngestWorkerResponse) => {
      this.handleMessage(message);
    });
    worker.on("error", (error) => {
      if (this.worker === worker) {
        this.worker = null;
        this.rejectPending(error);
      }
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.worker = null;
        this.rejectPending(new Error(`ingest worker exited with code ${code}`));
      }
    });
    return worker;
  }

  private handleMessage(message: IngestWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    switch (message.type) {
      case "result":
        pending.resolve(message.report);
        return;
      case "error":
        pending.reject(new Error(message.error));
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
