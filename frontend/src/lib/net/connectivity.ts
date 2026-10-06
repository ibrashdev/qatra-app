import type { ConnectivityReason } from "@/lib/api/errors";
import type { RequestMonitor, RequestOutcome } from "@/lib/api/monitor";
import type { WakeUpController, WakeUpPhase } from "@/lib/api/wakeup";

// PWA-design 3, 6 and 8 for the page that is already open. `navigator.onLine` is only a hint (it can say "online" with no route out), a failed request is
// better evidence, and the free server waking up is connectivity too, never a status of the learner's data (D48). This store joins the three so a shell can
// tell "this device has no connection" from "the server is not answering yet":
//   offline            the browser says there is no connection (cause "browser"), or a request failed before any answer arrived (cause "request")
//   server_unavailable the browser is online and no request failed to leave, but the server is waking up or has not answered after 90 s
//   online             nothing speaks against the connection
// An answer from the application of any kind (a success or an error envelope, a 401 among them) proves the server is reachable, so it never counts as offline.
export type ConnectivityStatus = "online" | "offline" | "server_unavailable";
export type ConnectivityCause = "browser" | "request";

export interface ConnectivityState {
  readonly status: ConnectivityStatus;
  readonly cause: ConnectivityCause | null; // set only while the status is "offline"
  // Counts the times the status moved INTO "offline". A shell that has been left for good in one episode is not entered again by the same episode.
  readonly episode: number;
}

export const INITIAL_CONNECTIVITY: ConnectivityState = { status: "online", cause: null, episode: 0 };

export interface ConnectivitySources {
  monitor: RequestMonitor;
  wakeUp: Pick<WakeUpController, "getState" | "subscribe">;
}

export class ConnectivityController {
  #state: ConnectivityState = INITIAL_CONNECTIVITY;
  readonly #listeners = new Set<() => void>();
  #browserOffline = false;
  // A request failed before the network answered (fetch itself threw). Cleared by any application answer, by the browser reporting the connection back,
  // by the server's health answering after a wake-up, and by a confirmed check (`markReachable`).
  #linkFailure = false;
  #wakePhase: WakeUpPhase = "idle";
  #windowAttached = false;

  getState = (): ConnectivityState => this.#state;

  // Attaches to the browser's connection events on the first subscriber (SSR-safe: there is no window on the server), and lets go with the last one.
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#attachWindow();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#detachWindow();
    };
  };

  // Watches the monitor of the client and the wake-up controller. Returns the function that stops both.
  attach({ monitor, wakeUp }: ConnectivitySources): () => void {
    this.#wakePhase = wakeUp.getState().phase;
    const stopMonitor = monitor.subscribe({ onSettle: (_id, outcome, reason) => this.#onSettle(outcome, reason) });
    const stopWake = wakeUp.subscribe(() => this.#onWake(wakeUp.getState().phase));
    this.#recompute();
    return () => {
      stopMonitor();
      stopWake();
    };
  }

  // A check the shell made on its own (an account answer, a sync) proved the server reachable: the last request failure no longer counts.
  markReachable(): void {
    this.#linkFailure = false;
    this.#recompute();
  }

  #onSettle(outcome: RequestOutcome, reason: ConnectivityReason | undefined): void {
    if (outcome === "connectivity" && reason === "network") {
      this.#linkFailure = true;
    } else if (outcome === "success" || outcome === "api_error") {
      this.#linkFailure = false;
    } else {
      // A timeout, a gateway answer and an invalid answer say the server is slow or asleep (the wake-up controller speaks for them), not that there is no
      // connection; an aborted request says nothing.
      return;
    }
    this.#recompute();
  }

  #onWake(phase: WakeUpPhase): void {
    this.#wakePhase = phase;
    // The server's own health answered: the way to it is open again.
    if (phase === "ready") this.#linkFailure = false;
    this.#recompute();
  }

  readonly #onBrowserOffline = (): void => {
    this.#browserOffline = true;
    this.#recompute();
  };

  readonly #onBrowserOnline = (): void => {
    this.#browserOffline = false;
    // The browser saying the connection is back does not prove the server is reachable, but it retires the failure seen while it said otherwise: a request
    // that fails again raises it again. Without this a page that makes no new request would keep a stale "offline" for good.
    this.#linkFailure = false;
    this.#recompute();
  };

  #attachWindow(): void {
    if (this.#windowAttached || typeof window === "undefined") return;
    this.#windowAttached = true;
    window.addEventListener("offline", this.#onBrowserOffline);
    window.addEventListener("online", this.#onBrowserOnline);
    // The flag is read as a hint, once, when watching starts; the events keep it current from then on.
    this.#browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    this.#recompute();
  }

  #detachWindow(): void {
    if (!this.#windowAttached || typeof window === "undefined") return;
    this.#windowAttached = false;
    window.removeEventListener("offline", this.#onBrowserOffline);
    window.removeEventListener("online", this.#onBrowserOnline);
  }

  #recompute(): void {
    let status: ConnectivityStatus;
    let cause: ConnectivityCause | null = null;
    if (this.#browserOffline) {
      status = "offline";
      cause = "browser";
    } else if (this.#linkFailure) {
      status = "offline";
      cause = "request";
    } else if (this.#wakePhase === "waking" || this.#wakePhase === "timed_out") {
      status = "server_unavailable";
    } else {
      status = "online";
    }
    const previous = this.#state;
    if (previous.status === status && previous.cause === cause) return;
    const episode = status === "offline" && previous.status !== "offline" ? previous.episode + 1 : previous.episode;
    this.#state = { status, cause, episode };
    for (const listener of [...this.#listeners]) listener();
  }
}
