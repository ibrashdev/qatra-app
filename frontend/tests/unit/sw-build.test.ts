// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_URL, REQUIRED_ICONS, SHELL_URL, buildServiceWorker, cacheNameFor, collectBuild, listFiles, renderServiceWorker, validateAllowlist } from "../../scripts/build-sw.mjs";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "qatra-sw-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface FixtureOptions {
  buildId?: string | null;
  offline?: boolean;
  manifest?: boolean;
  icons?: string[];
  staticFiles?: string[];
}

async function put(file: string, content = "x"): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function fixture(options: FixtureOptions = {}, base = root) {
  const dist = path.join(base, ".next");
  const pub = path.join(base, "public");
  if (options.buildId !== null) await put(path.join(dist, "BUILD_ID"), `${options.buildId ?? "BUILD1"}\n`);
  for (const file of options.staticFiles ?? ["chunks/app.js", "chunks/site.css", "chunks/lazy.js", "chunks/app.js.map", "media/cairo.woff2", "BUILD1/_buildManifest.js"]) await put(path.join(dist, "static", file));
  if (options.offline !== false) await put(path.join(dist, "server", "app", "offline.html"), "<html></html>");
  if (options.manifest !== false) await put(path.join(dist, "server", "app", "manifest.webmanifest.body"), "{}");
  for (const icon of options.icons ?? REQUIRED_ICONS) await put(path.join(pub, ...icon.split("/").filter(Boolean)));
  return { dist, pub, out: path.join(pub, "sw.js") };
}

const GOOD = [SHELL_URL, MANIFEST_URL, ...REQUIRED_ICONS, "/_next/static/chunks/app.js", "/_next/static/chunks/site.css"];

describe("validateAllowlist (it must fail on /api, on anything personal and on missing artifacts)", () => {
  it("accepts the public shell", () => {
    expect(validateAllowlist(GOOD)).toEqual([]);
  });

  it.each([
    ["/api/me"],
    ["/api"],
    ["/api/offline-snapshots/s1"],
  ])("rejects an /api URL: %s", (url) => {
    expect(validateAllowlist([...GOOD, url]).join("\n")).toMatch(/\/api URL must never be cached/);
  });

  it.each(["/today", "/settings/password", "/session/abc", "/login", "/_next/data/x.json", "/sw.js", "/favicon.ico"])("rejects a personal or unknown route: %s", (url) => {
    expect(validateAllowlist([...GOOD, url]).join("\n")).toMatch(/not part of the public shell/);
  });

  it("rejects a query, a fragment, a backslash, a parent path, a source map, a duplicate and a non-path", () => {
    const problems = validateAllowlist([...GOOD, "/_next/static/a.js?v=1", "/_next/static/a.js#x", "/_next/static\\a.js", "/_next/static/../x.js", "/_next/static/a.js.map", "/offline", "https://elsewhere.example/a.js", "//elsewhere.example/a.js", "relative.js"]).join("\n");
    expect(problems).toMatch(/query, fragment, backslash or "\.\."/);
    expect(problems).toMatch(/source map/);
    expect(problems).toMatch(/duplicate entry: \/offline/);
    expect(problems).toMatch(/not a same-origin path: https:\/\/elsewhere\.example\/a\.js/);
    expect(problems).toMatch(/not a same-origin path: \/\/elsewhere\.example\/a\.js/);
    expect(problems).toMatch(/not a same-origin path: relative\.js/);
  });

  it("requires the shell, the manifest, every icon, and JavaScript and CSS from the build", () => {
    expect(validateAllowlist(GOOD.filter((url) => url !== SHELL_URL)).join()).toMatch(/missing from the allowlist: \/offline/);
    expect(validateAllowlist(GOOD.filter((url) => url !== MANIFEST_URL)).join()).toMatch(/missing from the allowlist: \/manifest\.webmanifest/);
    expect(validateAllowlist(GOOD.filter((url) => url !== "/icons/maskable-512.png")).join()).toMatch(/maskable-512/);
    expect(validateAllowlist(GOOD.filter((url) => !url.endsWith(".js"))).join()).toMatch(/no JavaScript/);
    expect(validateAllowlist(GOOD.filter((url) => !url.endsWith(".css"))).join()).toMatch(/no CSS/);
    expect(validateAllowlist([])).toEqual(["the allowlist is empty"]);
  });
});

describe("collectBuild reads the production build, never guesses", () => {
  it("lists every static file except source maps, plus the shell, manifest and icons, sorted", async () => {
    const { dist, pub } = await fixture();
    const build = await collectBuild({ distDir: dist, publicDir: pub });
    expect(build.problems).toEqual([]);
    expect(build.buildId).toBe("BUILD1");
    expect(build.assets).toEqual(
      [SHELL_URL, MANIFEST_URL, ...REQUIRED_ICONS, "/_next/static/BUILD1/_buildManifest.js", "/_next/static/chunks/app.js", "/_next/static/chunks/lazy.js", "/_next/static/chunks/site.css", "/_next/static/media/cairo.woff2"].sort(),
    );
    expect(build.assets.some((url) => url.endsWith(".map"))).toBe(false);
  });

  it("reports what is missing on disk", async () => {
    expect((await collectBuild({ distDir: path.join(root, "nope"), publicDir: root })).problems.join()).toMatch(/BUILD_ID is missing/);
    const noShell = await fixture({ offline: false });
    expect((await collectBuild({ distDir: noShell.dist, publicDir: noShell.pub })).problems.join()).toMatch(/\/offline page is missing/);
  });

  it("lists files recursively in a stable order", async () => {
    await put(path.join(root, "a", "b.txt"));
    await put(path.join(root, "a", "c", "d.txt"));
    await put(path.join(root, "z.txt"));
    expect(await listFiles(root)).toEqual(["a/b.txt", "a/c/d.txt", "z.txt"]);
  });
});

describe("buildServiceWorker", () => {
  it("writes a worker whose allowlist is the build, in valid JavaScript", async () => {
    const { dist, pub, out } = await fixture();
    const result = await buildServiceWorker({ distDir: dist, publicDir: pub, outPath: out });
    expect(result).toMatchObject({ ok: true, problems: [], warnings: [] });
    const source = await readFile(out, "utf8");
    expect(() => new vm.Script(source)).not.toThrow();
    expect(source.startsWith("/* GENERATED by scripts/build-sw.mjs")).toBe(true);
    expect(source).toContain('"buildId": "BUILD1"');
    expect(source).toContain('"/_next/static/chunks/lazy.js"');
    expect(/\.map"/.test(source)).toBe(false);
    expect(result.config?.assets.some((url) => url.startsWith("/api"))).toBe(false);
    expect(result.config?.cacheName).toMatch(/^qatra-shell-BUILD1-[0-9a-f]{12}$/);
  });

  it.each([
    ["no build id", { buildId: null }, /BUILD_ID is missing/],
    ["no static files", { staticFiles: [] }, /no files under/],
    ["no JavaScript", { staticFiles: ["chunks/site.css"] }, /no JavaScript/],
    ["no shell", { offline: false }, /\/offline page is missing/],
    ["no manifest", { manifest: false }, /manifest route is missing/],
    ["a missing icon", { icons: REQUIRED_ICONS.slice(1) }, /install icon missing: public\/icons\/icon-192\.png/],
  ] as [string, FixtureOptions, RegExp][])("fails, and writes nothing, with %s", async (_name, options, message) => {
    const { dist, pub, out } = await fixture(options);
    const result = await buildServiceWorker({ distDir: dist, publicDir: pub, outPath: out });
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(message);
    await expect(readFile(out, "utf8")).rejects.toThrow();
  });

  it("only the shell can be waved through by the flag, and the worker then cannot install", async () => {
    const { dist, pub, out } = await fixture({ offline: false });
    const result = await buildServiceWorker({ distDir: dist, publicDir: pub, outPath: out, allowMissingShell: true });
    expect(result.ok).toBe(true);
    expect(result.warnings.join()).toMatch(/\/offline page is missing/);
    // /offline stays in the allowlist, so its install fails and the shell is never reported ready.
    expect(await readFile(out, "utf8")).toContain('"/offline"');
    const noIcon = await fixture({ offline: false, icons: [] }, path.join(root, "second"));
    expect((await buildServiceWorker({ distDir: noIcon.dist, publicDir: noIcon.pub, outPath: noIcon.out, allowMissingShell: true })).ok).toBe(false);
  });

  it("the cache name changes with the build id and with the files, and is stable otherwise", () => {
    const a = cacheNameFor("B1", GOOD);
    expect(cacheNameFor("B1", GOOD)).toBe(a);
    expect(cacheNameFor("B2", GOOD)).not.toBe(a);
    expect(cacheNameFor("B1", [...GOOD, "/_next/static/chunks/more.js"])).not.toBe(a);
    expect(cacheNameFor("we ird/id$&", GOOD)).toMatch(/^qatra-shell-weirdid-[0-9a-f]{12}$/);
  });

  it("fills the template without interpreting dollar signs in the config", () => {
    const template = "/*@config*/ { buildId: 'x' } /*@end*/\nconst a = 1;";
    const rendered = renderServiceWorker(template, { buildId: "$&$1", cachePrefix: "p", cacheName: "p-$`", shellUrl: "/offline", assets: ["/offline"] });
    expect(rendered).toContain('"buildId": "$&$1"');
    expect(rendered).toContain('"cacheName": "p-$`"');
    expect(() => renderServiceWorker("no block here", { buildId: "x", cachePrefix: "p", cacheName: "n", shellUrl: "/offline", assets: [] })).toThrow(/no \/\*@config\*\//);
  });
});

describe("the command line (what `pnpm build` runs after `next build`)", () => {
  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [path.join(frontendDir, "scripts", "build-sw.mjs"), ...args], { encoding: "utf8", env: { ...process.env, QATRA_SW_ALLOW_MISSING_SHELL: "", ...env } });
  }

  it("exits 0 and says what it wrote", async () => {
    const { dist, pub, out } = await fixture();
    const result = run(["--dist-dir", dist, "--public-dir", pub, "--out", out]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\[build-sw\] wrote .*build BUILD1, 11 files/);
    expect((await readFile(out, "utf8")).length).toBeGreaterThan(1000);
  });

  it("exits 1 and lists the problems when an artifact is missing, so a broken build cannot ship", async () => {
    const { dist, pub, out } = await fixture({ offline: false, icons: ["/icons/icon-192.png"] });
    const result = run(["--dist-dir", dist, "--public-dir", pub, "--out", out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/was not written/);
    expect(result.stderr).toMatch(/\/offline page is missing/);
    expect(result.stderr).toMatch(/install icon missing/);
  });

  it("the flag or QATRA_SW_ALLOW_MISSING_SHELL=1 lets only the missing shell through, with a warning", async () => {
    const { dist, pub, out } = await fixture({ offline: false });
    const byFlag = run(["--dist-dir", dist, "--public-dir", pub, "--out", out, "--allow-missing-shell"]);
    expect(byFlag.status).toBe(0);
    expect(byFlag.stderr).toMatch(/WARNING: the prerendered \/offline page is missing/);
    await rm(out);
    const byEnv = run(["--dist-dir", dist, "--public-dir", pub, "--out", out], { QATRA_SW_ALLOW_MISSING_SHELL: "1" });
    expect(byEnv.status).toBe(0);
  });

  it("rejects an unknown argument", async () => {
    const result = run(["--wat"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown argument/);
  });
});
