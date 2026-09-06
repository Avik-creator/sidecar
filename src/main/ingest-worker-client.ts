import { Worker } from "node:worker_threads";
import type { ApplyResult, ImproveReport, IngestReport } from "../shared/types.js";
import type {
  IngestWorkerRequest,
  IngestWorkerResponse,
  WorkerJob,
  WorkerValue,
} from "./ingest-protocol.js";

interface PendingJob {
  resolve: (value: WorkerValue) => void;
  reject: (error: Error) => void;
}

export class IngestWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingJob>();

  constructor(private readonly workerUrl: URL) {}

  ingest(): Promise<IngestReport> {
    return this.run({ type: "ingest" }) as Promise<IngestReport>;
  }

  runImprove(): Promise<ImproveReport> {
    return this.run({ type: "runImprove" }) as Promise<ImproveReport>;
  }

  applySuggestion(suggestionId: string): Promise<ApplyResult> {
    return this.run({ type: "applySuggestion", suggestionId }) as Promise<ApplyResult>;
  }

  undoSuggestion(suggestionId: string): Promise<ApplyResult> {
    return this.run({ type: "undoSuggestion", suggestionId }) as Promise<ApplyResult>;
  }

  async dismissSuggestion(suggestionId: string): Promise<void> {
    await this.run({ type: "dismissSuggestion", suggestionId });
  }

  private run(job: WorkerJob): Promise<WorkerValue> {
    const worker = this.getWorker();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: IngestWorkerRequest = { ...job, id };
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
        pending.resolve(message.value);
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
