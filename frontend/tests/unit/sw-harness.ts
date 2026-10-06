import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { renderServiceWorker, type ServiceWorkerConfig } from "../../scripts/build-sw.mjs";

// Runs scripts/sw-template.js (rendered by the real builder) against fakes of the worker globals, so install, activate, fetch and message are exercised
// without a browser. The worker file is plain JavaScript that uses `self`, `caches`, `clients`, `fetch`, `URL` and `Response`.

export const ORIGIN = "https://app.test";

export const TEMPLATE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/sw-template.js");
export const TEMPLATE = readFileSync(TEMPLATE_PATH, "utf8");

export const ASSETS = [
  "/_next/static/BUILD/_buildManifest.js",
  "/_next/static/chunks/app.js",
  "/_next/static/chunks/lazy-game.js",
  "/_next/static/chunks/site.css",
  "/_next/static/media/cairo.woff2",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/manifest.webmanifest",
  "/offline",
];

export function testConfig(overrides: Partial<ServiceWorkerConfig> = {}): ServiceWorkerConfig {
  return { buildId: "BUILD", cachePrefix: "qatra-shell-", cacheName: "qatra-shell-BUILD-abc123", shellUrl: "/offline", assets: ASSETS, ...overrides };
}

const pathOf = (url: string | Request): string => new URL(typeof url === "string" ? url : url.url, ORIGIN).pathname;

export class FakeCache {
  readonly entries = new Map<string, Response>();
  put = vi.fn(async (request: string | Request, response: Response) => {
    this.entries.set(pathOf(request), response);
  });
  match = vi.fn(async (request: string | Request, options?: { ignoreSearch?: boolean }) => {
    void options;
    return this.entries.get(pathOf(request));
  });
  keys = vi.fn(async () => [...this.entries.keys()].map((key) => new Request(`${ORIGIN}${key}`)));
}

export class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  open = vi.fn(async (name: string) => {
    let cache = this.stores.get(name);
    if (cache === undefined) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return cache;
  });
  has = vi.fn(async (name: string) => this.stores.has(name));
  keys = vi.fn(async () => [...this.stores.keys()]);
  delete = vi.fn(async (name: string) => this.stores.delete(name));
}

export interface FetchOutcome {
  status?: number;
  body?: string;
  contentType?: string;
  error?: Error;
}

export function loadServiceWorker(config: ServiceWorkerConfig = testConfig()) {
  const source = renderServiceWorker(TEMPLATE, config);
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const caches = new FakeCacheStorage();
  const posted: unknown[] = [];
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  const network = new Map<string, FetchOutcome>();
  const clientsApi = {
    matchAll: vi.fn(async () => [{ postMessage: (message: unknown) => posted.push(message) }]),
    claim: vi.fn(async () => undefined),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: clientsApi,
  };
  const fetchFn = vi.fn(async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    fetchCalls.push({ url, init });
    const outcome = network.get(pathOf(url)) ?? defaultOutcome(pathOf(url));
    if (outcome.error) throw outcome.error;
    return new Response(outcome.body ?? "ok", { status: outcome.status ?? 200, headers: { "content-type": outcome.contentType ?? "application/octet-stream" } });
  });
  const factory = new Function("self", "caches", "clients", "fetch", "URL", "Response", `${source}\nreturn { routeRequest, CONFIG };`) as (...args: unknown[]) => {
    routeRequest: (request: unknown, scope: unknown) => string;
    CONFIG: ServiceWorkerConfig;
  };
  const exported = factory(self, caches, clientsApi, fetchFn, URL, Response);

  function defaultOutcome(requestPath: string): FetchOutcome {
    return requestPath === "/offline" ? { contentType: "text/html; charset=utf-8", body: "<!doctype html><html></html>" } : {};
  }

  async function dispatch(type: "install" | "activate"): Promise<void> {
    const waits: Promise<unknown>[] = [];
    for (const listener of listeners.get(type) ?? []) listener({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
  }

  interface FetchResult {
    responded: boolean;
    response: Promise<Response> | null;
  }

  function dispatchFetch(request: { url: string; method?: string; mode?: string; headers?: Record<string, string> }): FetchResult {
    const result: FetchResult = { responded: false, response: null };
    const headers = new Headers(request.headers ?? {});
    const event = {
      request: { method: request.method ?? "GET", url: request.url, mode: request.mode ?? "no-cors", headers },
      respondWith: (promise: Promise<Response>) => {
        result.responded = true;
        result.response = Promise.resolve(promise);
      },
    };
    for (const listener of listeners.get("fetch") ?? []) listener(event);
    return result;
  }

  async function dispatchMessage(data: unknown, withPort = false): Promise<unknown[]> {
    const replies: unknown[] = [];
    const waits: Promise<unknown>[] = [];
    const port = { postMessage: (message: unknown) => replies.push(message) };
    const event = { data, ports: withPort ? [port] : [], source: { postMessage: (message: unknown) => replies.push(message) }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
    for (const listener of listeners.get("message") ?? []) listener(event);
    await Promise.all(waits);
    return replies;
  }

  return { source, self, caches, clients: clientsApi, posted, fetchCalls, fetchFn, network, routeRequest: exported.routeRequest, config: exported.CONFIG, dispatch, dispatchFetch, dispatchMessage, listeners };
}

export type LoadedWorker = ReturnType<typeof loadServiceWorker>;
