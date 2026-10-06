import type { SessionEvent } from "@/lib/api/types";
import type { FlushResult, ResponseHandler } from "./event-queue";

// The seam that lets one run component work in two places. The online app runs a session or a game round against the server with a page-memory queue
// (no backend is passed: every default below is the old behaviour, unchanged). The offline shell passes a backend, and the same run then keeps its answers
// in IndexedDB, ends on the device and leaves into the shell instead of the router (offline-spec 4.4, decision G-03).

// What a run asks of its outbox. `SessionEventQueue` satisfies it with `enqueue` returning nothing; the durable queue returns a promise that settles when
// the event is committed, and a screen shows no feedback for an answer before that.
export interface RunQueue {
  readonly size: number;
  enqueue(event: SessionEvent): void | Promise<void>;
  flush(): Promise<FlushResult>;
  setResponseHandler(handler: ResponseHandler): void;
}

export interface RunBackendBanner {
  variant: "info" | "warning";
  text: string;
}

export interface RunBackend {
  // The durable, enveloped outbox of this run.
  queue: RunQueue;
  // The line under the bar while the run is offline (the fixed offline-pending line of the offline messages), or the storage failure after a failed write.
  banner: RunBackendBanner | null;
  // The run ended after its last step: close it on the device and show the local provisional summary. No E22 (G-03).
  finish(): Promise<void>;
  // Leave the run (the sheet's «leave», the empty state, a missing session): back to the shell. No E22.
  leave(): void;
  // E21 or another call answered 401: the shell shows the G-03 line; nothing is wiped.
  sessionEnded(): void;
  // A write to IndexedDB failed: the answer or interval was NOT stored, so the screen shows no feedback for it.
  storageFailed(error: unknown): void;
}

export function isPromiseLike(value: unknown): value is Promise<void> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
