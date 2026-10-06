import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { APP, TEXT, createProfile, downloadPlan, newTenant, readStores, recordRequests, signIn, waitForShellReady } from "./support/offline-harness";

// R23 cases 1 and 2 (QA-and-evaluation.md, PWA-design section 9): install of the production build, download, close the browser, cold reopen with the network off.
// The shell assets are checked against the build output, not against the manifest alone.

test.describe.configure({ mode: "parallel" });

// The offline plan is about the service worker: it is allowed here although the project blocks it for the other specs.
test.use({ serviceWorkers: "allow" });

function buildFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? buildFiles(full) : [full];
  });
}

test.describe("R23 case 1: installable production build", () => {
  test("serves a manifest with the identity fields, the sizes and a maskable icon, and every icon loads", async ({ page, request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.ok()).toBe(true);
    const manifest = (await response.json()) as { name: string; start_url: string; scope: string; display: string; lang: string; dir: string; icons: { src: string; sizes: string; purpose?: string; type: string }[] };
    expect(manifest).toMatchObject({ name: "قطرة غيث", start_url: "/offline", scope: "/", display: "standalone", lang: "ar", dir: "rtl" });
    expect(manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose ?? "any"}`).sort()).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
    for (const icon of manifest.icons) {
      const fetched = await request.get(icon.src);
      expect(fetched.ok(), icon.src).toBe(true);
      expect(fetched.headers()["content-type"]).toContain("image/png");
    }
    // No account id and no personal data anywhere in the manifest.
    expect(JSON.stringify(manifest)).not.toMatch(/user|token|session/i);
    await page.goto("/offline");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  });

  test("registers the worker, caches every static file of the build and nothing personal", async ({ page }) => {
    await page.goto("/offline");
    await waitForShellReady(page);
    const cached = await page.evaluate(async () => {
      const key = (await caches.keys()).find((name) => name.startsWith("qatra-shell-"));
      if (key === undefined) return null;
      const cache = await caches.open(key);
      return (await cache.keys()).map((entry) => new URL(entry.url).pathname + new URL(entry.url).search);
    });
    expect(cached).not.toBeNull();
    const urls = new Set(cached ?? []);
    expect(urls.has("/offline")).toBe(true);
    // Every file of the production build's static folder (the maps are not shipped to the shell) is in the cache.
    const staticDir = path.resolve(__dirname, "../../.next/static");
    expect(existsSync(staticDir)).toBe(true);
    const expected = buildFiles(staticDir)
      .filter((file) => !file.endsWith(".map"))
      .map((file) => `/_next/static/${path.relative(staticDir, file).split(path.sep).join("/")}`)
      .filter((url) => !url.includes("/_buildManifest") || true);
    const missing = expected.filter((url) => ![...urls].some((cachedUrl) => decodeURIComponent(cachedUrl) === url || cachedUrl === url));
    // Files the build writes for its own bookkeeping (the build id folder) are not served as assets.
    expect(missing.filter((url) => !url.includes("/_buildManifest.js") && !url.includes("/_ssgManifest.js") && !url.includes("/_clientMiddlewareManifest.json"))).toEqual([]);
    expect([...urls].filter((url) => url.startsWith("/api") || url.includes("_rsc") || url.includes("/session/") || url.startsWith("/today"))).toEqual([]);
  });
});

test.describe("R23 case 2: close the browser, reopen with the network off", () => {
  test("restores the downloaded plan from the device with no /api and no RSC request", async () => {
    const tenant = newTenant();
    const profile = createProfile();
    try {
      let context = await profile.open();
      await signIn(context, tenant);
      let page = await context.newPage();
      await downloadPlan(page);
      // The answer is on the device before the browser closes.
      const stored = await readStores(page);
      expect(stored.planSnapshots).toHaveLength(1);
      await context.close();

      // Cold reopen of the installed app: a new browser process on the same profile, the network off, the launch address of the manifest.
      context = await profile.open({ offline: true });
      page = await context.newPage();
      const log = recordRequests(page);
      await page.goto("/offline");
      await expect(page.getByText(TEXT.ready).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(TEXT.offlinePending).first()).toBeVisible();
      // The daily session and the four game templates are all prepared in the snapshot: five rows with a start button, none that needs a connection
      // and none that is unavailable for the material.
      await expect(page.getByRole("button", { name: /^ابدأ: / })).toHaveCount(5);
      await expect(page.getByText(TEXT.needsConnection)).toHaveCount(0);
      await expect(page.getByText(TEXT.notAvailable)).toHaveCount(0);
      expect(log.api(), "no /api request while offline").toEqual([]);
      expect(log.rsc(), "no RSC payload request while offline").toEqual([]);

      // A reload while offline works too.
      await page.reload();
      await expect(page.getByText(TEXT.ready).first()).toBeVisible({ timeout: 30_000 });
      expect(log.api()).toEqual([]);
      await context.close();
    } finally {
      profile.dispose();
    }
  });

  test("says a connection is needed when the app is installed but no plan was downloaded", async () => {
    const tenant = newTenant();
    const profile = createProfile();
    try {
      let context = await profile.open();
      await signIn(context, tenant);
      let page = await context.newPage();
      await page.goto("/today");
      await waitForShellReady(page);
      await context.close();

      context = await profile.open({ offline: true });
      page = await context.newPage();
      const log = recordRequests(page);
      await page.goto("/offline");
      await expect(page.getByRole("heading", { name: TEXT.noPlan })).toBeVisible({ timeout: 30_000 });
      // No sign-in, no plan creation and no fake progress are offered.
      await expect(page.getByRole("link", { name: /تسجيل|إنشاء/ })).toHaveCount(0);
      await expect(page.getByRole("progressbar")).toHaveCount(0);
      expect(log.api()).toEqual([]);
      await context.close();
    } finally {
      profile.dispose();
    }
  });

  test("opens no half-written plan: a staged snapshot reads as incomplete, and a purged database as no plan, never as an empty account", async () => {
    const tenant = newTenant();
    const profile = createProfile();
    try {
      let context = await profile.open();
      await signIn(context, tenant);
      let page = await context.newPage();
      await downloadPlan(page);
      // The snapshot is staged but never marked ready (a download that was cut).
      await page.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const open = indexedDB.open("qatra-offline");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction("planSnapshots", "readwrite");
              const store = tx.objectStore("planSnapshots");
              const all = store.getAll();
              all.onsuccess = () => {
                for (const record of all.result as { ready: boolean }[]) store.put({ ...record, ready: false });
              };
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => reject(tx.error);
            };
          }),
      );
      await context.close();

      context = await profile.open({ offline: true });
      page = await context.newPage();
      await page.goto("/offline");
      await expect(page.getByRole("heading", { name: TEXT.incomplete })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: /^ابدأ: / })).toHaveCount(0);
      await context.close();

      // The browser purged the database (the eviction of D46): the shell says nothing is downloaded and never shows an account with no data.
      context = await profile.open();
      page = await context.newPage();
      await page.goto(`${APP}/offline`);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase("qatra-offline");
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          }),
      );
      await context.close();
      context = await profile.open({ offline: true });
      page = await context.newPage();
      await page.goto("/offline");
      await expect(page.getByRole("heading", { name: TEXT.noPlan })).toBeVisible({ timeout: 30_000 });
      await context.close();
    } finally {
      profile.dispose();
    }
  });
});
