/* Qatra service worker. Source: frontend/scripts/sw-template.js. The file served as /sw.js is generated from it by scripts/build-sw.mjs after `next build`
 * (the build id and the allowlist are filled in); never edit public/sw.js by hand.
 *
 * What it does (PWA-design 3, offline-spec 3.1):
 *   - precaches the public shell only: /offline, every file of .next/static, the manifest and the icons, in a cache named by the build;
 *   - serves those exact URLs from the cache, and the shell for a navigation to /offline;
 *   - sends a navigation that fails (no network) to /offline, without carrying the query, and never stores or returns a personal page;
 *   - touches nothing else: /api, any non-GET, Server Actions, RSC (Flight) requests and other origins go straight to the network (no respondWith);
 *   - never replays a request and never takes over a page by itself: a waiting worker activates only when the page sends SKIP_WAITING at a safe point.
 */
/* global self, caches, clients, fetch, URL, Response */

const CONFIG = /*@config*/ {
  buildId: "template",
  cachePrefix: "qatra-shell-",
  cacheName: "qatra-shell-template",
  shellUrl: "/offline",
  assets: [],
} /*@end*/;

const MESSAGE_SKIP_WAITING = "SKIP_WAITING";
const MESSAGE_GET_STATUS = "GET_STATUS";
const MESSAGE_STATUS = "STATUS";
const MESSAGE_SHELL_READY = "SHELL_READY";

const ASSETS = new Set(CONFIG.assets);

// Pure decision for one request, so it can be tested without a browser. `request` needs method, url, mode and headers.get.
//   'network'    no respondWith: the browser handles the request as if there were no worker
//   'shell'      a navigation to the shell: cache first
//   'navigation' any other navigation: network, and the shell when the network fails
//   'precached'  an allowlisted file: cache first
function routeRequest(request, scope) {
  if (request.method !== "GET") return "network";
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return "network";
  }
  if (url.origin !== scope.origin) return "network";
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/")) return "network";
  const header = (name) => (request.headers && typeof request.headers.get === "function" ? request.headers.get(name) : null);
  if (header("rsc") || header("next-router-prefetch") || header("next-router-state-tree") || header("next-action") || url.searchParams.has("_rsc")) return "network";
  if (request.mode === "navigate") return path === scope.shellUrl ? "shell" : "navigation";
  return scope.assets.has(path) ? "precached" : "network";
}

function scopeOf() {
  return { origin: self.location.origin, shellUrl: CONFIG.shellUrl, assets: ASSETS };
}

function pathOf(url) {
  return new URL(url, self.location.origin).pathname;
}

// All or nothing: one missing or odd file fails the install, so the previous version stays valid and the learner is never told the shell is ready when
// it is not. `redirect: 'error'` also refuses a login redirect or a preview-protection page standing in for a file.
async function precache() {
  const cache = await caches.open(CONFIG.cacheName);
  try {
    await Promise.all(
      CONFIG.assets.map(async (url) => {
        const response = await fetch(url, { cache: "reload", credentials: "same-origin", redirect: "error" });
        if (!response.ok) throw new Error("precache failed: " + url + " answered " + response.status);
        if (url === CONFIG.shellUrl) {
          const type = response.headers.get("content-type") || "";
          if (type.indexOf("text/html") === -1) throw new Error("precache failed: the shell is not HTML");
        }
        await cache.put(url, response);
      }),
    );
  } catch (error) {
    await caches.delete(CONFIG.cacheName);
    throw error;
  }
}

async function announceShellReady() {
  const all = await clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of all) client.postMessage({ type: MESSAGE_SHELL_READY, buildId: CONFIG.buildId });
}

async function deleteOldCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.indexOf(CONFIG.cachePrefix) === 0 && name !== CONFIG.cacheName).map((name) => caches.delete(name)));
}

async function cachedResponse(path) {
  const cache = await caches.open(CONFIG.cacheName);
  // Ignore the search: a deployment may append ?dpl=... to its asset URLs, and the allowlist is by path.
  return cache.match(path, { ignoreSearch: true });
}

async function shellStatus() {
  if (!(await caches.has(CONFIG.cacheName))) return { missing: CONFIG.assets.length, total: CONFIG.assets.length };
  const cache = await caches.open(CONFIG.cacheName);
  const present = new Set((await cache.keys()).map((request) => pathOf(request.url)));
  let missing = 0;
  for (const asset of CONFIG.assets) if (!present.has(asset)) missing += 1;
  return { missing, total: CONFIG.assets.length };
}

async function replyStatus(event) {
  const status = await shellStatus();
  const reply = {
    type: MESSAGE_STATUS,
    buildId: CONFIG.buildId,
    cacheName: CONFIG.cacheName,
    shellReady: status.total > 0 && status.missing === 0,
    missing: status.missing,
    total: status.total,
  };
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(reply);
  else if (event.source && typeof event.source.postMessage === "function") event.source.postMessage(reply);
}

self.addEventListener("install", (event) => {
  // No skipWaiting here: an update waits until the page asks for it at a safe point.
  event.waitUntil(precache().then(announceShellReady));
});

self.addEventListener("activate", (event) => {
  // No clients.claim: a page is controlled by the worker that was active when it loaded, and a reload picks up the new one.
  event.waitUntil(deleteOldCaches());
});

self.addEventListener("fetch", (event) => {
  const decision = routeRequest(event.request, scopeOf());
  if (decision === "network") return;
  if (decision === "shell") {
    event.respondWith(cachedResponse(CONFIG.shellUrl).then((hit) => hit || fetch(event.request)));
    return;
  }
  if (decision === "precached") {
    event.respondWith(cachedResponse(pathOf(event.request.url)).then((hit) => hit || fetch(event.request)));
    return;
  }
  // A navigation: the network answers when it can. When it cannot, the learner lands on the public shell, with no query and nothing personal kept.
  event.respondWith(
    fetch(event.request).catch(() => {
      return Response.redirect(new URL(CONFIG.shellUrl, self.location.origin).href, 302);
    }),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data.type !== "string") return;
  if (data.type === MESSAGE_SKIP_WAITING) {
    self.skipWaiting();
    return;
  }
  if (data.type === MESSAGE_GET_STATUS) event.waitUntil(replyStatus(event));
});
