import type { RequestMonitor, RequestOutcome } from "./monitor";

// G-01 and API-spec 1.11 (final rule, UG-06). idle: nothing. busy: a request has been pending for 1 s (neutral indicator).
// waking: the free server is probably asleep (the line). timed_out: 90 s without an answer (retry button). ready: health answered.
export type WakeUpPhase = "idle" | "busy" | "waking" | "timed_out" | "ready";

export interface WakeUpState {
  readonly phase: WakeUpPhase;
}

export const PENDING_THRESHOLD_MS = 1_000;
export const PROBE_WINDOW_MS = 2_000;
export const POLL_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];
export const POLL_CAP_MS = 10_000;
export const WAKE_MAX_MS = 90_000;
export const READY_HOLD_MS = 5_000;

export interface WakeUpOptions {
  // Resolves true only when GET /api/health answered with ok; false or a rejection counts as no answer.
  probe: (signal: AbortSignal) => Promise<boolean>;
  pendingThresholdMs?: number;
  probeWindowMs?: number;
  backoffMs?: readonly number[];
  capMs?: number;
  maxWaitMs?: number;
  readyHoldMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

const IDLE: WakeUpState = { phase: "idle" };

export function pollDelayMs(index: number, backoffMs = POLL_BACKOFF_MS, capMs = POLL_CAP_MS): number {
  return backoffMs[index] ?? capMs;
}

// The wake-up state never touches local data, never asks for a login and never marks anything stale (D48, D70).
export class WakeUpController {
  readonly #options: Required<WakeUpOptions>;
  #state: WakeUpState = IDLE;
  readonly #listeners = new Set<() => void>();
  readonly #readyListeners = new Set<() => void>();
  // Request id to its 1 s timer; null once the timer has fired and the request is still pending.
  readonly #pending = new Map<number, Timer | null>();
  // Each wait or poll belongs to one episode; a result from an older episode is ignored.
  #episode = 0;
  #probeAbort: AbortController | null = null;
  #probeWindowTimer: Timer | null = null;
  #pollAbort: AbortController | null = null;
  #pollTimer: Timer | null = null;
  #deadlineTimer: Timer | null = null;
  #readyTimer: Timer | null = null;

  constructor(options: WakeUpOptions) {
    this.#options = {
      pendingThresholdMs: PENDING_THRESHOLD_MS,
      probeWindowMs: PROBE_WINDOW_MS,
      backoffMs: POLL_BACKOFF_MS,
      capMs: POLL_CAP_MS,
      maxWaitMs: WAKE_MAX_MS,
      readyHoldMs: READY_HOLD_MS,
      ...options,
    };
  }

  getState = (): WakeUpState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // Fires when health answers after a wake-up; screens re-issue their reads here.
  onReady(listener: () => void): () => void {
    this.#readyListeners.add(listener);
    return () => {
      this.#readyListeners.delete(listener);
    };
  }

  attach(monitor: RequestMonitor): () => void {
    return monitor.subscribe({
      onStart: (id) => this.#onRequestStart(id),
      onSettle: (id, outcome) => this.#onRequestSettle(id, outcome),
    });
  }

  retry(): void {
    if (this.#state.phase !== "timed_out") return;
    this.#episode += 1;
    this.#setPhase("waking");
    this.#startLoop(true);
  }

  dispose(): void {
    this.#episode += 1;
    for (const timer of this.#pending.values()) if (timer !== null) clearTimeout(timer);
    this.#pending.clear();
    this.#clearProbe();
    this.#clearLoop();
    this.#clearReadyTimer();
    this.#listeners.clear();
    this.#readyListeners.clear();
  }

  #onRequestStart(id: number): void {
    const timer = setTimeout(() => this.#onPendingThreshold(id), this.#options.pendingThresholdMs);
    this.#pending.set(id, timer);
  }

  #onPendingThreshold(id: number): void {
    if (!this.#pending.has(id)) return;
    this.#pending.set(id, null);
    if (this.#state.phase !== "idle" && this.#state.phase !== "ready") return;
    this.#clearReadyTimer();
    this.#setPhase("busy");
    this.#startProbe();
  }

  #onRequestSettle(id: number, outcome: RequestOutcome): void {
    if (!this.#pending.has(id)) return;
    const timer = this.#pending.get(id);
    if (timer) clearTimeout(timer);
    this.#pending.delete(id);

    const { phase } = this.#state;
    if (outcome === "connectivity") {
      this.#enterWaking();
    } else if (outcome === "success" || outcome === "api_error") {
      // An answer from the application proves the server is up, whatever the answer was.
      if (phase === "waking" || phase === "timed_out") this.#markReady();
      else if (phase === "busy" && this.#pending.size === 0) this.#backToIdle();
    } else if (phase === "busy" && this.#pending.size === 0) {
      this.#backToIdle();
    }
  }

  #startProbe(): void {
    this.#episode += 1;
    const episode = this.#episode;
    const abort = new AbortController();
    this.#probeAbort = abort;
    this.#probeWindowTimer = setTimeout(() => {
      if (this.#episode === episode) this.#enterWaking();
    }, this.#options.probeWindowMs);
    this.#options.probe(abort.signal).then(
      (answered) => {
        if (this.#episode !== episode) return;
        this.#clearProbe();
        if (!answered) this.#enterWaking();
        else if (this.#pending.size === 0) this.#backToIdle();
      },
      () => {
        if (this.#episode !== episode) return;
        this.#clearProbe();
        this.#enterWaking();
      },
    );
  }

  #enterWaking(): void {
    if (this.#state.phase === "waking" || this.#state.phase === "timed_out") return;
    this.#clearProbe();
    this.#clearReadyTimer();
    this.#episode += 1;
    this.#setPhase("waking");
    this.#startLoop(false);
  }

  #startLoop(immediateFirstPoll: boolean): void {
    const episode = this.#episode;
    this.#deadlineTimer = setTimeout(() => {
      if (this.#episode === episode) this.#enterTimedOut();
    }, this.#options.maxWaitMs);
    this.#schedulePoll(episode, 0, immediateFirstPoll);
  }

  #schedulePoll(episode: number, index: number, immediate = false): void {
    const delay = immediate ? 0 : pollDelayMs(index, this.#options.backoffMs, this.#options.capMs);
    this.#pollTimer = setTimeout(() => this.#runPoll(episode, index), delay);
  }

  #runPoll(episode: number, index: number): void {
    if (this.#episode !== episode) return;
    const abort = new AbortController();
    this.#pollAbort = abort;
    this.#options.probe(abort.signal).then(
      (answered) => {
        if (this.#episode !== episode) return;
        if (answered) this.#markReady();
        else this.#schedulePoll(episode, index + 1);
      },
      () => {
        if (this.#episode === episode) this.#schedulePoll(episode, index + 1);
      },
    );
  }

  #enterTimedOut(): void {
    this.#episode += 1;
    this.#clearLoop();
    this.#setPhase("timed_out");
  }

  #markReady(): void {
    this.#episode += 1;
    this.#clearLoop();
    this.#setPhase("ready");
    for (const listener of [...this.#readyListeners]) listener();
    this.#readyTimer = setTimeout(() => {
      if (this.#state.phase === "ready") this.#setPhase("idle");
    }, this.#options.readyHoldMs);
  }

  #backToIdle(): void {
    this.#episode += 1;
    this.#clearProbe();
    this.#setPhase("idle");
  }

  #clearProbe(): void {
    if (this.#probeWindowTimer !== null) clearTimeout(this.#probeWindowTimer);
    this.#probeWindowTimer = null;
    this.#probeAbort?.abort();
    this.#probeAbort = null;
  }

  #clearLoop(): void {
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer);
    if (this.#deadlineTimer !== null) clearTimeout(this.#deadlineTimer);
    this.#pollTimer = null;
    this.#deadlineTimer = null;
    this.#pollAbort?.abort();
    this.#pollAbort = null;
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
  }

  #setPhase(phase: WakeUpPhase): void {
    if (this.#state.phase === phase) return;
    this.#state = { phase };
    for (const listener of [...this.#listeners]) listener();
  }
}
