import { publishOfflineMessage } from "@/lib/offline/broadcast";
import type { UpdateState } from "@/lib/offline/types";
import { SW_MESSAGE_SKIP_WAITING } from "./protocol";

// The safe update of PWA-design 8 and offline-spec 3.4. A new worker waits: it never takes over during a run or an outbox write. The page shows a calm
// notice and, once nothing is running, tells the waiting worker to activate, then reloads when the controller has changed. The old caches go with the old
// worker's activation; the outbox is never touched by an update.

export const RUN_LOCK_NAME = "qatra-run";
const ACTIVATION_TIMEOUT_MS = 10_000;

type RegistrationLike = Pick<ServiceWorkerRegistration, "waiting"> | null | undefined;

export function inspectUpdate(registration: RegistrationLike): UpdateState {
  if (registration === null || registration === undefined) return { phase: "idle" };
  return registration.waiting !== null && registration.waiting !== undefined ? { phase: "available" } : { phase: "idle" };
}

// A run holds a shared Web Lock for as long as it is active, so every other tab can see it. Where Web Locks are missing, only this tab's own runs are
// known (a counter), which is the honest limit and is documented in the update flow.
let localRuns = 0;

export async function holdRunLock(): Promise<() => void> {
  localRuns += 1;
  let released = false;
  const releaseCounter = () => {
    if (!released) {
      released = true;
      localRuns = Math.max(0, localRuns - 1);
    }
  };
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) return releaseCounter;
  return new Promise<() => void>((resolve) => {
    let releaseLock: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      releaseLock = done;
    });
    locks
      .request(RUN_LOCK_NAME, { mode: "shared" }, () => {
        resolve(() => {
          releaseCounter();
          releaseLock();
        });
        return held;
      })
      .catch(() => resolve(releaseCounter));
  });
}

export async function isRunActiveAnywhere(): Promise<boolean> {
  if (localRuns > 0) return true;
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined || typeof locks.query !== "function") return false;
  try {
    const state = await locks.query();
    return (state.held ?? []).some((lock) => lock.name === RUN_LOCK_NAME);
  } catch {
    return false;
  }
}

export interface ApplyUpdateOptions {
  // Default: no run is active in any tab.
  isSafe?: () => boolean | Promise<boolean>;
  reload?: () => void;
  timeoutMs?: number;
  onState?: (state: UpdateState) => void;
}

// Enabled only at a safe point. Posts SKIP_WAITING to the waiting worker, waits for the new controller (or for the worker to report `activated`), then
// reloads. A worker that does not activate within the time limit is a `failed` state with the old worker still in charge: nothing was lost.
export async function applyUpdateWhenSafe(registration: Pick<ServiceWorkerRegistration, "waiting"> | null | undefined, options: ApplyUpdateOptions = {}): Promise<UpdateState> {
  if (registration === null || registration === undefined) return { phase: "failed", failureCode: "no_registration" };
  const waiting = registration.waiting;
  if (waiting === null || waiting === undefined) return { phase: "idle" };
  const isSafe = options.isSafe ?? (async () => !(await isRunActiveAnywhere()));
  if (!(await isSafe())) return { phase: "available", failureCode: "not_safe" };
  options.onState?.({ phase: "applying" });
  const worker: ServiceWorker = waiting;

  const activated = await new Promise<boolean>((resolve) => {
    const container = navigator.serviceWorker;
    const timer = setTimeout(() => done(false), options.timeoutMs ?? ACTIVATION_TIMEOUT_MS);
    function done(value: boolean) {
      clearTimeout(timer);
      container.removeEventListener("controllerchange", onChange);
      worker.removeEventListener("statechange", onState);
      resolve(value);
    }
    function onChange() {
      done(true);
    }
    function onState() {
      if (worker.state === "activated") done(true);
    }
    container.addEventListener("controllerchange", onChange);
    worker.addEventListener("statechange", onState);
    try {
      worker.postMessage({ type: SW_MESSAGE_SKIP_WAITING });
    } catch {
      done(false);
    }
  });
  if (!activated) return { phase: "failed", failureCode: "activation_timeout" };
  (options.reload ?? (() => window.location.reload()))();
  return { phase: "applying" };
}

// Watches a registration and reports the state at every change. Also asks the browser to look for a new worker when the page becomes visible again,
// which is how a long-open installed app finds an update without waiting for the next navigation.
export function watchForUpdates(registration: ServiceWorkerRegistration | null | undefined, onChange: (state: UpdateState) => void): () => void {
  if (registration === null || registration === undefined) {
    onChange({ phase: "idle" });
    return () => undefined;
  }
  const emit = () => {
    const state = inspectUpdate(registration);
    if (state.phase === "available") publishOfflineMessage({ type: "UPDATE_PENDING" });
    onChange(state);
  };
  const watchWorker = (worker: ServiceWorker | null) => {
    worker?.addEventListener("statechange", emit);
  };
  const onUpdateFound = () => {
    watchWorker(registration.installing);
    emit();
  };
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") registration.update().catch(() => undefined);
  };
  registration.addEventListener("updatefound", onUpdateFound);
  watchWorker(registration.installing);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  emit();
  return () => {
    registration.removeEventListener("updatefound", onUpdateFound);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
