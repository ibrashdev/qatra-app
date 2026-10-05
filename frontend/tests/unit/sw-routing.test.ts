// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SW_MESSAGE_GET_STATUS, SW_MESSAGE_SHELL_READY, SW_MESSAGE_SKIP_WAITING, SW_MESSAGE_STATUS } from "@/lib/pwa/protocol";
import { ASSETS, ORIGIN, TEMPLATE, loadServiceWorker, testConfig } from "./sw-harness";

type Extra = { method?: string; mode?: string; headers?: Record<string, string> };
const absolute = (url: string): string => (url.startsWith("http") ? url : `${ORIGIN}${url}`);

describe("routeRequest: what the worker touches and what it never does (offline-spec 3.1)", () => {
  const worker = loadServiceWorker();
  const scope = { origin: ORIGIN, shellUrl: "/offline", assets: new Set(ASSETS) };
  const route = (url: string, extra: Extra = {}) => worker.routeRequest({ url: absolute(url), method: extra.method ?? "GET", mode: extra.mode ?? "no-cors", headers: new Headers(extra.headers ?? {}) }, scope);

  it.each([
    ["the shell, as a navigation", "/offline", { mode: "navigate" }, "shell"],
    ["the shell with a query, which is never kept", "/offline?next=%2Ftoday", { mode: "navigate" }, "shell"],
    ["a learner page when the network fails later", "/today", { mode: "navigate" }, "navigation"],
    ["a login page", "/login?next=%2Fsettings", { mode: "navigate" }, "navigation"],
    ["a precached script", "/_next/static/chunks/app.js", {}, "precached"],
    ["a precached script with a deployment query", "/_next/static/chunks/app.js?dpl=dpl_123", {}, "precached"],
    ["a font", "/_next/static/media/cairo.woff2", {}, "precached"],
    ["an icon", "/icons/icon-192.png", {}, "precached"],
    ["the manifest", "/manifest.webmanifest", {}, "precached"],
  ])("%s", (_name, url, extra, expected) => {
    expect(route(url, extra)).toBe(expected);
  });

  it.each([
    ["an API read", "/api/me", {}],
    ["an API navigation", "/api/health", { mode: "navigate" }],
    ["an API path under a query", "/api/today?x=1", {}],
    ["an unlisted chunk of a newer deployment", "/_next/static/chunks/newer.js", {}],
    ["the worker file itself", "/sw.js", {}],
    ["an RSC (Flight) request by header", "/today", { headers: { RSC: "1" } }],
    ["an RSC prefetch", "/today", { headers: { "Next-Router-Prefetch": "1" } }],
    ["an RSC request with a router state", "/today", { headers: { "Next-Router-State-Tree": "%5B%5D" } }],
    ["an RSC request by query", "/today?_rsc=abc12", {}],
    ["a Server Action", "/today", { headers: { "Next-Action": "abc" } }],
    ["another origin (audio)", "https://everyayah.com/data/x.mp3", {}],
    ["another origin navigation", "https://elsewhere.example/page", { mode: "navigate" }],
    ["an image from the page", "/some/image.png", {}],
  ])("sends %s straight to the network", (_name, url, extra) => {
    expect(route(url, extra)).toBe("network");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("never touches a %s", (method) => {
    expect(route("/_next/static/chunks/app.js", { method })).toBe("network");
    expect(route("/offline", { method, mode: "navigate" })).toBe("network");
  });

  it("copes with a request whose URL cannot be parsed", () => {
    expect(worker.routeRequest({ method: "GET", url: "http://", mode: "no-cors", headers: new Headers() }, scope)).toBe("network");
  });
});

describe("install: the shell is ready only when every file is cached (all or nothing)", () => {
  it("fetches every allowlisted file fresh, without redirects, stores exactly the allowlist and announces SHELL_READY", async () => {
    const worker = loadServiceWorker();
    await worker.dispatch("install");

    expect(worker.fetchCalls.map((call) => call.url).sort()).toEqual([...ASSETS].sort());
    for (const call of worker.fetchCalls) expect(call.init).toMatchObject({ cache: "reload", credentials: "same-origin", redirect: "error" });
    const cache = worker.caches.stores.get(worker.config.cacheName);
    expect([...(cache?.entries.keys() ?? [])].sort()).toEqual([...ASSETS].sort());
    expect([...(cache?.entries.keys() ?? [])].some((key) => key.startsWith("/api"))).toBe(false);
    expect(worker.posted).toEqual([{ type: SW_MESSAGE_SHELL_READY, buildId: "BUILD" }]);
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
  });

  it("one missing file fails the install, leaves no half cache and announces nothing, so the previous version stays valid", async () => {
    const worker = loadServiceWorker();
    worker.network.set("/_next/static/chunks/lazy-game.js", { status: 404 });
    await expect(worker.dispatch("install")).rejects.toThrow(/lazy-game\.js/);
    expect(await worker.caches.has(worker.config.cacheName)).toBe(false);
    expect(worker.posted).toEqual([]);
  });

  it("a shell that is not HTML (a login or protection page) fails the install", async () => {
    const worker = loadServiceWorker();
    worker.network.set("/offline", { contentType: "application/json", body: "{}" });
    await expect(worker.dispatch("install")).rejects.toThrow(/not HTML/);
    expect(worker.posted).toEqual([]);
  });

  it("a redirect, which fetch refuses here, fails the install", async () => {
    const worker = loadServiceWorker();
    worker.network.set("/offline", { error: new TypeError("redirect mode is set to error") });
    await expect(worker.dispatch("install")).rejects.toThrow(/redirect/);
    expect(worker.caches.stores.has(worker.config.cacheName)).toBe(false);
  });

  it("a failed install keeps an older cache untouched", async () => {
    const worker = loadServiceWorker();
    await worker.caches.open("qatra-shell-OLD-aaa");
    worker.network.set("/icons/icon-512.png", { status: 500 });
    await expect(worker.dispatch("install")).rejects.toBeDefined();
    expect(worker.caches.stores.has("qatra-shell-OLD-aaa")).toBe(true);
  });
});

describe("activate: old shell caches go, nothing else, and no page is taken over", () => {
  it("deletes older qatra-shell caches only, keeps the current one and unrelated caches, never claims clients", async () => {
    const worker = loadServiceWorker();
    await worker.dispatch("install");
    await worker.caches.open("qatra-shell-OLD-aaa");
    await worker.caches.open("qatra-shell-OLDER-bbb");
    await worker.caches.open("someone-elses-cache");
    await worker.dispatch("activate");
    expect([...worker.caches.stores.keys()].sort()).toEqual([worker.config.cacheName, "someone-elses-cache"].sort());
    expect(worker.clients.claim).not.toHaveBeenCalled();
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
  });
});

describe("fetch", () => {
  async function installed() {
    const worker = loadServiceWorker();
    await worker.dispatch("install");
    worker.fetchCalls.length = 0;
    return worker;
  }

  it("serves the shell from the cache for a navigation to /offline, with no network", async () => {
    const worker = await installed();
    const result = worker.dispatchFetch({ url: `${ORIGIN}/offline`, mode: "navigate" });
    expect(result.responded).toBe(true);
    const response = await (result.response as Promise<Response>);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(worker.fetchCalls).toEqual([]);
  });

  it("serves a precached file from the cache, also when the URL has a deployment query", async () => {
    const worker = await installed();
    for (const url of ["/_next/static/chunks/lazy-game.js", "/_next/static/chunks/lazy-game.js?dpl=abc", "/icons/icon-512.png"]) {
      const result = worker.dispatchFetch({ url: `${ORIGIN}${url}` });
      expect(result.responded).toBe(true);
      expect((await (result.response as Promise<Response>)).status).toBe(200);
    }
    expect(worker.fetchCalls).toEqual([]);
  });

  it("falls through to the network when a precached file is missing from the cache", async () => {
    const worker = await installed();
    worker.caches.stores.get(worker.config.cacheName)?.entries.delete("/_next/static/chunks/app.js");
    const result = worker.dispatchFetch({ url: `${ORIGIN}/_next/static/chunks/app.js` });
    expect((await (result.response as Promise<Response>)).status).toBe(200);
    expect(worker.fetchCalls).toHaveLength(1);
  });

  it("sends the learner to /offline when a navigation fails for lack of a network, without carrying the query", async () => {
    const worker = await installed();
    worker.network.set("/today", { error: new TypeError("Failed to fetch") });
    const result = worker.dispatchFetch({ url: `${ORIGIN}/today?token=abc&user=1`, mode: "navigate" });
    const response = await (result.response as Promise<Response>);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/offline`);
  });

  it("lets a navigation through when the network works, and never stores the page", async () => {
    const worker = await installed();
    worker.network.set("/today", { body: "<html>personal</html>", contentType: "text/html" });
    const result = worker.dispatchFetch({ url: `${ORIGIN}/today`, mode: "navigate" });
    expect(await (await (result.response as Promise<Response>)).text()).toBe("<html>personal</html>");
    const cache = worker.caches.stores.get(worker.config.cacheName);
    expect(cache?.entries.has("/today")).toBe(false);
  });

  it.each([
    ["/api/me", {}],
    ["/api/sessions/s1/events", { method: "POST" }],
    ["/today", { headers: { RSC: "1" } }],
    ["/today?_rsc=x", {}],
    ["/_next/static/chunks/unlisted.js", {}],
    ["https://everyayah.com/data/x.mp3", {}],
  ])("does not answer %s at all: no respondWith, so the browser asks the network itself", async (url, extra) => {
    const worker = await installed();
    const result = worker.dispatchFetch({ url: url.startsWith("http") ? url : `${ORIGIN}${url}`, ...extra });
    expect(result.responded).toBe(false);
    expect(worker.fetchCalls).toEqual([]);
  });

  it("writes to the cache only while installing, never while serving", async () => {
    const worker = loadServiceWorker();
    await worker.dispatch("install");
    const cache = worker.caches.stores.get(worker.config.cacheName);
    const putsAfterInstall = cache?.put.mock.calls.length;
    for (const url of ["/offline", "/_next/static/chunks/app.js", "/today", "/api/me"]) worker.dispatchFetch({ url: `${ORIGIN}${url}`, mode: url === "/today" || url === "/offline" ? "navigate" : "no-cors" });
    expect(cache?.put.mock.calls.length).toBe(putsAfterInstall);
    expect(putsAfterInstall).toBe(ASSETS.length);
  });
});

describe("messages", () => {
  it("SKIP_WAITING activates the waiting worker, and nothing else does", async () => {
    const worker = loadServiceWorker();
    await worker.dispatchMessage({ type: "something" });
    await worker.dispatchMessage(null);
    await worker.dispatchMessage("SKIP_WAITING");
    await worker.dispatchMessage({ type: 5 });
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
    await worker.dispatchMessage({ type: SW_MESSAGE_SKIP_WAITING });
    expect(worker.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("GET_STATUS says the shell is ready only when every file is in the cache, and counts what is missing", async () => {
    const worker = loadServiceWorker();
    const [before] = await worker.dispatchMessage({ type: SW_MESSAGE_GET_STATUS }, true);
    expect(before).toMatchObject({ type: SW_MESSAGE_STATUS, buildId: "BUILD", shellReady: false, missing: ASSETS.length, total: ASSETS.length });

    await worker.dispatch("install");
    const [ready] = await worker.dispatchMessage({ type: SW_MESSAGE_GET_STATUS }, true);
    expect(ready).toMatchObject({ shellReady: true, missing: 0, cacheName: worker.config.cacheName });

    worker.caches.stores.get(worker.config.cacheName)?.entries.delete("/_next/static/chunks/lazy-game.js");
    const [broken] = await worker.dispatchMessage({ type: SW_MESSAGE_GET_STATUS }, true);
    expect(broken).toMatchObject({ shellReady: false, missing: 1 });
  });

  it("answers on the message port when there is one, else to the source", async () => {
    const worker = loadServiceWorker();
    expect(await worker.dispatchMessage({ type: SW_MESSAGE_GET_STATUS }, true)).toHaveLength(1);
    expect(await worker.dispatchMessage({ type: SW_MESSAGE_GET_STATUS }, false)).toHaveLength(1);
  });

  it("an empty allowlist is never ready", async () => {
    const worker = loadServiceWorker(testConfig({ assets: [] }));
    const [status] = await worker.dispatchMessage({ type: SW_MESSAGE_GET_STATUS }, true);
    expect(status).toMatchObject({ shellReady: false, total: 0 });
  });
});

describe("the template itself", () => {
  it("repeats the message names of lib/pwa/protocol.ts", () => {
    for (const value of [SW_MESSAGE_SKIP_WAITING, SW_MESSAGE_GET_STATUS, SW_MESSAGE_STATUS, SW_MESSAGE_SHELL_READY]) expect(TEMPLATE).toContain(`"${value}"`);
  });

  it("calls skipWaiting in one place only (the message), and never claims clients", () => {
    expect(TEMPLATE.match(/skipWaiting\(/g)).toHaveLength(1);
    expect(/clients\.claim\s*\(/.test(TEMPLATE)).toBe(false);
  });

  it("writes to a cache in one place only (the install precache), and never replays a request", () => {
    expect(TEMPLATE.match(/cache\.put\(/g)).toHaveLength(1);
    expect(/SyncManager|BackgroundSync|periodicSync|registration\.sync|navigator\.onLine|XMLHttpRequest/.test(TEMPLATE)).toBe(false);
  });

  it("is valid JavaScript before and after the config is filled in", () => {
    expect(() => new Function("self", "caches", "clients", "fetch", "URL", "Response", TEMPLATE)).not.toThrow();
    expect(() => loadServiceWorker()).not.toThrow();
  });
});
