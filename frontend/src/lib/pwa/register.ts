import { inspectLocalPlan } from "@/lib/offline/plan-cache";
import type { OfflineReadiness, ShellStatus } from "@/lib/offline/types";
import { SW_MESSAGE_GET_STATUS, SW_MESSAGE_SHELL_READY, SW_MESSAGE_STATUS } from "./protocol";

// Registration and the readiness of the shell (PWA-design 3, offline-spec 3.1). A registration and a manifest do not prove readiness: the shell is ready
// when the worker's cache holds every file of its allowlist, and the plan is ready when its snapshot is. Both are checked at every boot because no
// transaction spans Cache Storage and IndexedDB.

export const SERVICE_WORKER_URL = "/sw.js";
export const SERVICE_WORKER_SCOPE = "/";

const STATUS_TIMEOUT_MS = 3_000;

export function isServiceWorkerSupported(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext === true;
}

// The development server has no built allowlist, so a worker from an older build would serve a stale `/offline`: it is registered in production builds
// (and in a development build only when NEXT_PUBLIC_ENABLE_SW=1).
function registrationAllowed(): boolean {
  return process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_ENABLE_SW === "1";
}

function afterLoad(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}

// Safe failure: an unsupported browser, a missing file or a blocked registration returns null and the app keeps working online.
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported() || !registrationAllowed()) return null;
  try {
    await afterLoad();
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE, updateViaCache: "none" });
  } catch {
    return null;
  }
}

interface StatusReply {
  type: typeof SW_MESSAGE_STATUS;
  buildId: string;
  shellReady: boolean;
  missing: number;
  total: number;
}

function isStatusReply(value: unknown): value is StatusReply {
  if (typeof value !== "object" || value === null) return false;
  const reply = value as Partial<StatusReply>;
  return reply.type === SW_MESSAGE_STATUS && typeof reply.shellReady === "boolean" && typeof reply.missing === "number" && typeof reply.buildId === "string";
}

function queryWorker(worker: ServiceWorker, timeoutMs: number): Promise<StatusReply | null> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "undefined") {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(isStatusReply(event.data) ? event.data : null);
    };
    try {
      worker.postMessage({ type: SW_MESSAGE_GET_STATUS }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export async function getShellStatus(timeoutMs: number = STATUS_TIMEOUT_MS): Promise<ShellStatus> {
  const none: ShellStatus = { supported: false, registered: false, controlled: false, shellReady: false, buildId: null, missing: 0 };
  if (!isServiceWorkerSupported()) return none;
  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
  } catch {
    registration = undefined;
  }
  if (registration === undefined) return { ...none, supported: true };
  const controlled = navigator.serviceWorker.controller !== null && navigator.serviceWorker.controller !== undefined;
  const worker = registration.active;
  if (worker === null) return { supported: true, registered: true, controlled, shellReady: false, buildId: null, missing: 0 };
  const reply = await queryWorker(worker, timeoutMs);
  if (reply === null) return { supported: true, registered: true, controlled, shellReady: false, buildId: null, missing: 0 };
  return { supported: true, registered: true, controlled, shellReady: reply.shellReady, buildId: reply.buildId, missing: reply.missing };
}

// The worker announces `SHELL_READY` once every file is cached (after install). A page that missed it reads the status instead.
export function subscribeShellReady(handler: () => void): () => void {
  if (!isServiceWorkerSupported()) return () => undefined;
  const onMessage = (event: MessageEvent<unknown>) => {
    const data = event.data as { type?: unknown } | null;
    if (data !== null && typeof data === "object" && data.type === SW_MESSAGE_SHELL_READY) handler();
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

export function combineReadiness(shell: Pick<ShellStatus, "shellReady">, planStatus: string): OfflineReadiness {
  const shellReady = shell.shellReady;
  const snapshotReady = planStatus === "ready";
  return { shellReady, snapshotReady, ready: shellReady && snapshotReady };
}

export async function getOfflineReadiness(): Promise<OfflineReadiness> {
  const [shell, plan] = await Promise.all([getShellStatus(), inspectLocalPlan()]);
  return combineReadiness(shell, plan.status);
}
