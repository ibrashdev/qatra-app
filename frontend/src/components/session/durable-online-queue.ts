import type { Endpoints } from "@/lib/api/endpoints";
import type { EventsResponse, SessionEvent } from "@/lib/api/types";
import { isOfflineStorageSupported } from "@/lib/offline/db";
import {
  applyOnlineEventsResponse,
  bindOnlineAccount,
  confirmOnlineCompletion,
  currentOnlineBinding,
  listOnlineEvents,
  readOnlineRun,
  recordOnlineEvents,
  requestOnlineCompletion,
  saveOnlineRun,
  type OnlineRunPatch,
} from "@/lib/offline/online-journal";
import type { OnlineBinding, OnlineEventRecord, OnlineRunRecord, OnlineSessionKind } from "@/lib/offline/types";
import { SessionEventQueue, type FlushResult, type ResponseHandler } from "./event-queue";
import type { RunQueue } from "./run-backend";

// The outbox of an ORDINARY online session (PWA-design 4, offline phase 2): the page-memory queue of S-19 with the online journal behind it. An answer or an
// activity interval is committed to IndexedDB BEFORE it enters the queue that sends it, so a reload, a closed tab or a lost connection no longer loses an
// answer that was already shown as checked. The server still answers every event: an acknowledged or duplicate event leaves the journal, a pending one
// stays without credit for the foreground sync, a rejected one is kept visibly blocked. Every event keeps its id and its original session id, and none is
// ever enveloped or sent through the offline outbox (an enveloped event belongs to a prepared session).
//
// An online session must always keep working. A queue whose storage is missing, whose account is not known or whose write failed does not stop the run: it
// carries on in page memory exactly as before and says so (`mode`, `storageProblem`), and the screen's banners stay truthful about it.

// "binding": the account of the journal is still being resolved. "durable": events are committed to the journal first. "memory": nothing is stored on the
// device (no storage, no known account, or a write failed), the events live in this page until the server has them.
export type OnlineQueueMode = "binding" | "durable" | "memory";

export interface OnlineQueueStatus {
  readonly mode: OnlineQueueMode;
  // True once a write to the device failed after the journal was in use: the answers of this page are no longer saved there.
  readonly storageProblem: boolean;
}

export const IDLE_QUEUE_STATUS: OnlineQueueStatus = { mode: "memory", storageProblem: false };

// How long an answer may wait for the account to be resolved before the run goes on in memory. The account is normally known already (a sign-in records it);
// the wait only matters on a device whose sign-in predates the journal and needs one E11 call.
export const BINDING_WAIT_MS = 2500;

// The journal calls the queue uses, replaceable in a test.
export interface OnlineJournalStore {
  record: typeof recordOnlineEvents;
  apply: typeof applyOnlineEventsResponse;
  saveRun: typeof saveOnlineRun;
  requestCompletion: typeof requestOnlineCompletion;
  confirmCompletion: typeof confirmOnlineCompletion;
}

const JOURNAL_STORE: OnlineJournalStore = {
  record: recordOnlineEvents,
  apply: applyOnlineEventsResponse,
  saveRun: saveOnlineRun,
  requestCompletion: requestOnlineCompletion,
  confirmCompletion: confirmOnlineCompletion,
};

export interface DurableOnlineQueueOptions {
  sessionId: string;
  kind: OnlineSessionKind;
  send: (events: SessionEvent[]) => Promise<EventsResponse>;
  // The binding of the signed-in account, or null when the device cannot hold one. Never throws into the queue.
  resolveBinding: () => Promise<OnlineBinding | null>;
  bindingWaitMs?: number;
  store?: Partial<OnlineJournalStore>;
}

// What a finish asks of the journal: the key to send with E22 and whether the finish is now recorded on the device.
export interface RequestedCompletion {
  key: string;
  durable: boolean;
}

// The account of this device's journal: the one already recorded (a sign-in records it), else the signed-in account asked once (E11) and bound. Null when
// there is no storage, the view is locked, another account owns the device or the request failed; the run then simply goes on in memory.
export async function resolveOnlineBinding(api: Pick<Endpoints, "me">): Promise<OnlineBinding | null> {
  if (!isOfflineStorageSupported()) return null;
  try {
    const known = await currentOnlineBinding();
    if (known !== null) return known;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    const profile = await api.me();
    return await bindOnlineAccount(profile.username);
  } catch {
    return null;
  }
}

export class DurableOnlineQueue implements RunQueue {
  private readonly inner: SessionEventQueue;
  private readonly store: OnlineJournalStore;
  private readonly listeners = new Set<() => void>();
  // The journal records of the events that are in the queue, by id: what the answer of the server settles.
  private readonly records = new Map<string, OnlineEventRecord>();
  private status: OnlineQueueStatus;
  private binding: OnlineBinding | null = null;
  private started: Promise<void> | null = null;
  // Writes are chained so events enter the queue that sends them in the order enqueue was called.
  private chain: Promise<void> = Promise.resolve();
  private runChain: Promise<void> = Promise.resolve();
  private writing = 0;

  constructor(private readonly options: DurableOnlineQueueOptions) {
    this.store = { ...JOURNAL_STORE, ...options.store };
    // Without storage there is nothing to resolve: the queue is a plain page-memory queue from the first call.
    this.status = isOfflineStorageSupported() ? { mode: "binding", storageProblem: false } : IDLE_QUEUE_STATUS;
    this.inner = new SessionEventQueue({ send: (events) => this.send(events) });
  }

  // For useSyncExternalStore: the banners of the run read the mode and the storage problem here.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): OnlineQueueStatus => this.status;

  get mode(): OnlineQueueMode {
    return this.status.mode;
  }

  get storageProblem(): boolean {
    return this.status.storageProblem;
  }

  // Events not yet sent: those in the queue and those whose write is still running.
  get size(): number {
    return this.inner.size + this.writing;
  }

  setResponseHandler(handler: ResponseHandler): void {
    this.inner.setResponseHandler(handler);
  }

  // Resolves the account once. Safe to call again; a screen calls it when it mounts so the first answer does not wait for it.
  start(): Promise<void> {
    this.started ??= this.bind();
    return this.started;
  }

  // Puts the events of the journal that were never acknowledged (state `queued`, in replay order) into the queue, for a page that was reloaded. They are not
  // written again: they are already stored. `pending` and `blocked` records are left to the foreground sync.
  restore(records: readonly OnlineEventRecord[]): void {
    for (const record of records) {
      if (record.state !== "queued" || record.sessionId !== this.options.sessionId || this.records.has(record.clientEventId)) continue;
      this.records.set(record.clientEventId, record);
      this.inner.enqueue(record.event);
    }
  }

  // Resolves when the event is stored (or, when it cannot be stored, when it has been taken into the page's memory): it never rejects, because an online session
  // must keep working. In memory mode with nothing in flight it is a plain synchronous enqueue.
  enqueue(event: SessionEvent): void | Promise<void> {
    if (this.status.mode === "memory" && this.writing === 0) {
      this.inner.enqueue(event);
      return;
    }
    this.writing += 1;
    const write = this.chain.then(() => this.commit(event)).catch(() => undefined);
    this.chain = write;
    return write;
  }

  // Waits for the writes that are running, then sends everything waiting. Resolves with the first error and leaves the unsent events queued (and stored).
  async flush(): Promise<FlushResult> {
    await this.chain;
    return this.inner.flush();
  }

  // Where a reload resumes and what the learner already answered. Best effort and never throws: the events themselves are the record that matters.
  saveRun(patch: OnlineRunPatch): Promise<void> {
    const saved = this.runChain.then(async () => {
      await this.ready();
      const binding = this.binding;
      if (this.status.mode !== "durable" || binding === null) return;
      try {
        await this.store.saveRun(binding, this.options.sessionId, this.options.kind, patch);
      } catch {
        // The run state is a convenience on top of the events; losing it only costs the resume position.
      }
    });
    this.runChain = saved;
    return saved;
  }

  // The finish is owed to the server from this call on. Returns the key every attempt of this finish sends with E22: the stored one when a finish was already
  // recorded (also by an earlier page), else `proposedKey`. `durable` is false when it could not be recorded, and the screen then shows no promise for later.
  async requestCompletion(proposedKey: string): Promise<RequestedCompletion> {
    await this.ready();
    const binding = this.binding;
    if (this.status.mode !== "durable" || binding === null) return { key: proposedKey, durable: false };
    try {
      return { key: await this.store.requestCompletion(binding, this.options.sessionId, this.options.kind, proposedKey), durable: true };
    } catch {
      this.setStatus("memory", true);
      return { key: proposedKey, durable: false };
    }
  }

  // The server holds the finished session: the owed finish is dropped from the journal. Best effort: a failure leaves a record the sync settles with the same
  // key (the server answers a repeated finish with the stored result).
  async confirmCompletion(): Promise<void> {
    const binding = this.binding;
    if (binding === null) return;
    // A run-state save that is still running must not write the record again after it is gone.
    await this.runChain;
    try {
      await this.store.confirmCompletion(binding.accountKey, this.options.sessionId);
    } catch {
      // see above
    }
  }

  private async bind(): Promise<void> {
    if (this.status.mode !== "binding") return;
    let binding: OnlineBinding | null = null;
    try {
      binding = await this.options.resolveBinding();
    } catch {
      binding = null;
    }
    // The wait ran out (or a write failed) meanwhile: the queue already decided.
    if (this.status.mode !== "binding") return;
    this.binding = binding;
    this.setStatus(binding === null ? "memory" : "durable", false);
  }

  // Waits for the account, at most `bindingWaitMs`; after that the run goes on in memory.
  private async ready(): Promise<void> {
    if (this.status.mode !== "binding") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.bindingWaitMs ?? BINDING_WAIT_MS);
    });
    try {
      await Promise.race([this.start(), waited]);
    } finally {
      clearTimeout(timer);
    }
    if (this.status.mode === "binding") this.setStatus("memory", false);
  }

  private async commit(event: SessionEvent): Promise<void> {
    try {
      await this.ready();
      const binding = this.binding;
      if (this.status.mode === "durable" && binding !== null) {
        try {
          const [record] = await this.store.record(binding, this.options.sessionId, this.options.kind, [event]);
          if (record !== undefined) this.records.set(record.clientEventId, record);
        } catch {
          // The write failed (storage full or blocked, the account changed in another tab, the local copy was cleared): the event is not on the device, so
          // this page keeps it in memory, sends it as before, and says so.
          this.setStatus("memory", true);
        }
      }
    } finally {
      this.inner.enqueue(event);
      this.writing -= 1;
    }
  }

  // Every send goes to the original session id with the events exactly as stored. A thrown send leaves the journal untouched: the same ids go out again and the
  // server answers `duplicate`. The 200 settles the journal like the foreground sync does.
  private async send(events: SessionEvent[]): Promise<EventsResponse> {
    const response = await this.options.send(events);
    await this.settle(events, response);
    return response;
  }

  private async settle(events: readonly SessionEvent[], response: EventsResponse): Promise<void> {
    const sent: OnlineEventRecord[] = [];
    for (const event of events) {
      const record = this.records.get(event.clientEventId);
      if (record !== undefined) sent.push(record);
    }
    const first = sent[0];
    if (first === undefined) return;
    try {
      await this.store.apply(first.accountKey, sent, response);
    } catch {
      // A failed settle leaves the records queued; the foreground sync sends them again and the server answers `duplicate`, which removes them.
    }
    for (const record of sent) this.records.delete(record.clientEventId);
  }

  private setStatus(mode: OnlineQueueMode, storageProblem: boolean): void {
    const problem = storageProblem || this.status.storageProblem;
    if (this.status.mode === mode && this.status.storageProblem === problem) return;
    this.status = { mode, storageProblem: problem };
    for (const listener of [...this.listeners]) listener();
  }
}

// What a reload of an online session finds in the journal for that session (read next to E18, never blocking the load).
export interface SessionJournal {
  accountKey: string | null;
  run: OnlineRunRecord | null;
  // Events written by an earlier page that the server has not acknowledged, in replay order.
  queued: OnlineEventRecord[];
}

export const EMPTY_JOURNAL: SessionJournal = { accountKey: null, run: null, queued: [] };

// Never rejects: a device with no storage, no recorded account, a locked view or any failure reads as an empty journal. It does not ask the server for the
// account, so a load never waits for E11.
export async function readSessionJournal(sessionId: string): Promise<SessionJournal> {
  try {
    if (!isOfflineStorageSupported()) return EMPTY_JOURNAL;
    const binding = await currentOnlineBinding();
    if (binding === null) return EMPTY_JOURNAL;
    const [run, queued] = await Promise.all([
      readOnlineRun(binding.accountKey, sessionId),
      listOnlineEvents(binding.accountKey, { sessionId, states: ["queued"] }),
    ]);
    return { accountKey: binding.accountKey, run, queued };
  } catch {
    return EMPTY_JOURNAL;
  }
}
