import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, devices, expect, type BrowserContext, type Page, type Request } from "@playwright/test";

// Helpers of the offline specs (R23). The app and the stub backend listen on the ports the config chose; each spec has its own tenant on the stub, so specs
// run in parallel and still inject faults. Strings below are the fixed Arabic strings of the offline-spec (verbatim from the documents).

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3100);
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 3101);
export const APP = `http://127.0.0.1:${APP_PORT}`;
export const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
export const E2E_COOKIE = "qatra_e2e";

export const TEXT = {
  downloadCta: "نزّل الخطة للاستخدام دون اتصال",
  ready: "الخطة جاهزة دون اتصال",
  offlinePending: "غير متصل \u2014 النتائج بانتظار التحقق",
  savedOnDevice: "محفوظ على الجهاز، بانتظار المزامنة",
  synced: "متزامن",
  needsConnection: "هذه اللعبة تحتاج اتصالًا لتجهيزها مجددًا",
  sessionEnded: "انتهت جلستك. سجّل الدخول للمتابعة.",
  unavailable: "غير متاح",
  noPlan: "لا توجد خطة محمّلة على هذا الجهاز",
  incomplete: "لم يكتمل تنزيل الخطة",
  logoutDialogTitle: "تسجيل الخروج؟",
  updateTitle: "تحديث متاح",
} as const;

export function newTenant(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function configureStub(tenant: string, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${BACKEND}/__stub/config?tenant=${tenant}`, { method: "POST", body: JSON.stringify(patch) });
  expect(response.ok).toBe(true);
}

export interface StubState {
  acknowledged: string[];
  pending: string[];
  rejected: Record<string, string>;
  eventLog: { sessionId: string; clientEventId: string; type: string; localSequence: number; clientRunId: string; snapshotId: string; occurredAt: string }[];
  batches: number;
  snapshots: number;
  snapshotIds: string[];
  sessionIds: string[];
  answerResults: { clientEventId: string; correct: boolean }[];
  logoutCalls: number;
  requests: string[];
  daily: { dailyActiveMs: number; dailyPercent: number; dailyCompleted: boolean };
}

export async function stubState(tenant: string): Promise<StubState> {
  const response = await fetch(`${BACKEND}/__stub/state?tenant=${tenant}`);
  return (await response.json()) as StubState;
}

export async function signIn(context: BrowserContext, tenant: string): Promise<void> {
  await context.addCookies([{ name: E2E_COOKIE, value: tenant, url: APP }]);
}

// A browser profile that survives closing the browser: a cold reopen of the installed app (R23 case 2). Chromium only, the one the project installs.
export interface Profile {
  dir: string;
  open: (options?: { offline?: boolean; viewport?: { width: number; height: number }; locale?: string }) => Promise<BrowserContext>;
  dispose: () => void;
}

export function createProfile(): Profile {
  const dir = mkdtempSync(path.join(tmpdir(), "qatra-e2e-"));
  return {
    dir,
    async open({ offline = false, viewport, locale = "ar-AE" } = {}) {
      const context = await chromium.launchPersistentContext(dir, { ...devices["Desktop Chrome"], locale, ...(viewport === undefined ? {} : { viewport }) });
      if (offline) await context.setOffline(true);
      return context;
    },
    dispose() {
      // Best effort: Windows may still hold a file of the profile for a moment after the browser closed, and a leftover temp folder is harmless.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // left for the operating system to clean up
      }
    },
  };
}

// What the page asked of the network, so a spec can say "no /api request while offline" and "no RSC payload either".
export interface RequestLog {
  all: Request[];
  api: () => string[];
  rsc: () => string[];
  failedSameOrigin: () => string[];
}

export function recordRequests(page: Page): RequestLog {
  const all: Request[] = [];
  const failed: string[] = [];
  page.on("request", (request) => all.push(request));
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(APP)) failed.push(request.url());
  });
  return {
    all,
    api: () => all.map((request) => new URL(request.url())).filter((url) => url.pathname.startsWith("/api/")).map((url) => url.pathname),
    rsc: () => all.filter((request) => request.headers()["rsc"] !== undefined || new URL(request.url()).searchParams.has("_rsc")).map((request) => request.url()),
    failedSameOrigin: () => failed,
  };
}

// The service worker is active, so its install finished and every file of its shell is cached (all or nothing, PWA-design 4). A page that was open when the
// worker installed is not controlled by it (no clients.claim, by design): `control` reloads once, as a learner's second visit does.
export async function waitForShellReady(page: Page, { control = false }: { control?: boolean } = {}): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration("/");
          if (registration?.active == null) return false;
          const keys = await caches.keys();
          return keys.some((key) => key.startsWith("qatra-shell-"));
        }),
      { message: "the service worker is active and its shell cache exists", timeout: 45_000 },
    )
    .toBe(true);
  if (control) {
    await page.reload();
    await expect.poll(async () => page.evaluate(() => navigator.serviceWorker.controller !== null), { message: "the page is controlled by the worker" }).toBe(true);
  }
}

// Opens Today online, presses the download card and waits for the ready state. The page may reload once after the worker's first install, so the
// controlling worker is awaited first.
export async function downloadPlan(page: Page): Promise<void> {
  await page.goto("/today");
  await waitForShellReady(page);
  // The card is the same in both interface languages: the fixed Arabic line or the proposed English one.
  await page.getByRole("button", { name: /^(نزّل الخطة للاستخدام دون اتصال|Download the plan for offline use)$/ }).click();
  await expect(page.getByText(/^(الخطة جاهزة دون اتصال|Plan ready offline)$/).first()).toBeVisible({ timeout: 45_000 });
}

// Raw reads of the device's own database, to assert what is stored and what is not.
export async function readStores(page: Page): Promise<Record<string, unknown[]>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, unknown[]>>((resolve, reject) => {
        const open = indexedDB.open("qatra-offline");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = Array.from(db.objectStoreNames);
          const result: Record<string, unknown[]> = {};
          if (names.length === 0) {
            db.close();
            resolve(result);
            return;
          }
          const tx = db.transaction(names, "readonly");
          for (const name of names) {
            const request = tx.objectStore(name).getAll();
            request.onsuccess = () => {
              result[name] = request.result as unknown[];
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

export const VIEW = { phone: { width: 390, height: 844 }, floor: { width: 320, height: 640 }, desktop: { width: 1280, height: 800 } } as const;
