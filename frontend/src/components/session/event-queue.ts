import { ApiError } from "@/lib/api/errors";
import { MAX_EVENTS_PER_REQUEST } from "@/lib/api/session-endpoints";
import type { EventsResponse, SessionEvent } from "@/lib/api/types";

export type FlushResult = { ok: true } | { ok: false; error: unknown };

// Called for every answered request, with the events it carried. The events are settled (acknowledged, duplicate, pending or rejected):
// none is sent again (S-19: a rejected or a pending answer is shown calmly and not resent).
export type ResponseHandler = (response: EventsResponse, sent: readonly SessionEvent[]) => void;

export interface EventQueueOptions {
  send: (events: SessionEvent[]) => Promise<EventsResponse>;
  onResponse?: ResponseHandler;
}

// The page-memory outbox of S-19 (UI-screens "States", P-22): answers and activity intervals wait here until the server has them. Every event keeps its
// `clientEventId` for good, so a resend after a lost answer is a `duplicate` and never a second answer. Requests run one after another, so the
// order of the events is the order they were made in. The queue is lost on a reload; nothing is written to storage.
export class SessionEventQueue {
  private items: SessionEvent[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private batchLimit = MAX_EVENTS_PER_REQUEST;
  private onResponse: ResponseHandler;

  constructor(private readonly options: EventQueueOptions) {
    this.onResponse = options.onResponse ?? (() => undefined);
  }

  // A screen sets its handler once it is mounted, so a render never reads it.
  setResponseHandler(handler: ResponseHandler): void {
    this.onResponse = handler;
  }

  get size(): number {
    return this.items.length;
  }

  enqueue(event: SessionEvent): void {
    this.items.push(event);
  }

  // Sends everything waiting, in batches of at most 100 (smaller after a 413). Resolves with the first error, and leaves the unsent events queued.
  flush(): Promise<FlushResult> {
    const run = this.chain.then(
      () => this.drain(),
      () => this.drain(),
    );
    this.chain = run;
    return run;
  }

  private async drain(): Promise<FlushResult> {
    let dropped: unknown = null;
    while (this.items.length > 0) {
      const batch = this.items.slice(0, this.batchLimit);
      let response: EventsResponse;
      try {
        response = await this.options.send(batch);
      } catch (error) {
        if (error instanceof ApiError && error.status === 413) {
          // G-19: resend in smaller batches without a message. One event that is too large alone cannot be sent: it is dropped and reported.
          if (batch.length > 1) {
            this.batchLimit = Math.max(1, Math.floor(batch.length / 2));
            continue;
          }
          this.items.splice(0, 1);
          dropped = error;
          continue;
        }
        return { ok: false, error };
      }
      // The 200 settles every event of the batch; events added while it ran sit behind it and stay.
      this.items.splice(0, batch.length);
      this.onResponse(response, batch);
    }
    return dropped === null ? { ok: true } : { ok: false, error: dropped };
  }
}
