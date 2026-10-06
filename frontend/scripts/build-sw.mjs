// Generates public/sw.js after `next build` (package.json: "build": "next build && node scripts/build-sw.mjs").
//   node scripts/build-sw.mjs [--allow-missing-shell] [--dist-dir <dir>] [--public-dir <dir>] [--out <file>]
//
// The allowlist comes from the production build itself, never from guesses (PWA-design 3, offline-spec 3.1): every file of .next/static (js, css, fonts,
// every lazy chunk), the prerendered /offline shell, the manifest and the install icons. The builder FAILS when an /api or any other personal or unknown
// URL would be included, and when an expected artifact is missing, so a broken worker is never shipped. The worker itself comes from the committed
// template scripts/sw-template.js; public/sw.js is its generated output (gitignored) and is never edited by hand.
//
// --allow-missing-shell (or QATRA_SW_ALLOW_MISSING_SHELL=1) is for a checkout where the /offline page does not exist yet: the worker is still written
// with /offline in its allowlist, so its install fails and the shell is never reported ready. It is a development aid, not a way to ship.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SHELL_URL = "/offline";
export const MANIFEST_URL = "/manifest.webmanifest";
export const CACHE_PREFIX = "qatra-shell-";
export const REQUIRED_ICONS = ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"];
const STATIC_PREFIX = "/_next/static/";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "..");

export async function listFiles(dir) {
  const found = [];
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  }
  await walk(dir, "");
  return found.sort();
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

// The routes `next build` prerendered, from .next/prerender-manifest.json. A missing or unreadable manifest is an empty set, never an error:
// the caller falls back to the files under .next/server/app.
async function readPrerenderedRoutes(distDir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(distDir, "prerender-manifest.json"), "utf8"));
    const routes = manifest !== null && typeof manifest === "object" ? manifest.routes : undefined;
    return new Set(routes !== null && typeof routes === "object" ? Object.keys(routes) : []);
  } catch {
    return new Set();
  }
}

// Every problem of an allowlist, as sentences. Empty means the list is acceptable.
export function validateAllowlist(assets) {
  const problems = [];
  if (!Array.isArray(assets) || assets.length === 0) return ["the allowlist is empty"];
  const seen = new Set();
  for (const url of assets) {
    if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) {
      problems.push(`not a same-origin path: ${String(url)}`);
      continue;
    }
    if (seen.has(url)) problems.push(`duplicate entry: ${url}`);
    seen.add(url);
    if (url === "/api" || url.startsWith("/api/")) problems.push(`an /api URL must never be cached: ${url}`);
    else if (/[?#\\]|\.\./.test(url)) problems.push(`query, fragment, backslash or ".." in an entry: ${url}`);
    else if (url.endsWith(".map")) problems.push(`a source map must not be cached: ${url}`);
    else if (!(url === SHELL_URL || url === MANIFEST_URL || url.startsWith("/icons/") || url.startsWith(STATIC_PREFIX))) {
      problems.push(`not part of the public shell (a personal or unknown route?): ${url}`);
    }
  }
  const required = [SHELL_URL, MANIFEST_URL, ...REQUIRED_ICONS];
  for (const url of required) if (!seen.has(url)) problems.push(`expected artifact missing from the allowlist: ${url}`);
  const staticFiles = assets.filter((url) => typeof url === "string" && url.startsWith(STATIC_PREFIX));
  if (!staticFiles.some((url) => url.endsWith(".js"))) problems.push("no JavaScript file under /_next/static");
  if (!staticFiles.some((url) => url.endsWith(".css"))) problems.push("no CSS file under /_next/static");
  return problems;
}

// Reads the production build. `problems` lists what is missing on disk; the allowlist is still returned so a flag can decide what to do with it.
export async function collectBuild({ distDir, publicDir }) {
  const problems = [];
  const buildIdFile = path.join(distDir, "BUILD_ID");
  if (!(await exists(buildIdFile))) {
    problems.push(`${buildIdFile} is missing: run \`next build\` first`);
    return { buildId: null, assets: [], problems };
  }
  const buildId = (await readFile(buildIdFile, "utf8")).trim();
  if (buildId === "") problems.push("BUILD_ID is empty");

  const staticDir = path.join(distDir, "static");
  const staticFiles = (await exists(staticDir)) ? (await listFiles(staticDir)).filter((file) => !file.endsWith(".map")) : [];
  if (staticFiles.length === 0) problems.push(`no files under ${staticDir}`);

  const appDir = path.join(distDir, "server", "app");
  const appFiles = (await exists(appDir)) ? await readdir(appDir) : [];
  const prerenderedRoutes = await readPrerenderedRoutes(distDir);
  // The standard prerender manifest is the primary proof; the files under server/app are what a local build also writes. Vercel's build layout
  // lists the routes as static but does not keep the .html files in this directory, and the worker fetches /offline from the server at install time.
  const shellMissing = !(prerenderedRoutes.has(SHELL_URL) || appFiles.includes("offline.html") || appFiles.includes("offline.body"));
  if (shellMissing) problems.push("the prerendered /offline page is missing from the build (src/app/offline/page.tsx must be a static page)");
  if (!(prerenderedRoutes.has(MANIFEST_URL) || appFiles.some((name) => name.startsWith("manifest.webmanifest")))) problems.push("the manifest route is missing from the build (src/app/manifest.ts)");
  for (const url of REQUIRED_ICONS) {
    if (!(await exists(path.join(publicDir, ...url.split("/").filter(Boolean))))) problems.push(`install icon missing: public${url}`);
  }

  const assets = [SHELL_URL, MANIFEST_URL, ...REQUIRED_ICONS, ...staticFiles.map((file) => `${STATIC_PREFIX}${file}`)];
  return { buildId, assets: [...new Set(assets)].sort(), problems, shellMissing };
}

export function cacheNameFor(buildId, assets) {
  const hash = createHash("sha256").update(`${buildId}\n${assets.join("\n")}`).digest("hex").slice(0, 12);
  const safeId = String(buildId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return `${CACHE_PREFIX}${safeId}-${hash}`;
}

const CONFIG_PATTERN = /\/\*@config\*\/[\s\S]*?\/\*@end\*\//;

export function renderServiceWorker(template, config) {
  if (!CONFIG_PATTERN.test(template)) throw new Error("the template has no /*@config*/ ... /*@end*/ block");
  const json = JSON.stringify(config, null, 2);
  const banner = `/* GENERATED by scripts/build-sw.mjs from scripts/sw-template.js (build ${config.buildId}). Do not edit. */\n`;
  return banner + template.replace(CONFIG_PATTERN, () => `/*@config*/ ${json} /*@end*/`);
}

export async function buildServiceWorker(options = {}) {
  const distDir = options.distDir ?? path.join(frontendDir, ".next");
  const publicDir = options.publicDir ?? path.join(frontendDir, "public");
  const templatePath = options.templatePath ?? path.join(scriptDir, "sw-template.js");
  const outPath = options.outPath ?? path.join(publicDir, "sw.js");
  const allowMissingShell = options.allowMissingShell === true;

  const build = await collectBuild({ distDir, publicDir });
  const problems = [...build.problems];
  // Only the shell may be waved through, and only by the explicit flag: every other missing artifact still fails.
  const fatal = problems.filter((problem) => !(allowMissingShell && problem.startsWith("the prerendered /offline page is missing")));
  const warnings = problems.filter((problem) => !fatal.includes(problem));
  if (build.buildId === null) return { ok: false, problems: fatal, warnings };
  fatal.push(...validateAllowlist(build.assets));
  if (fatal.length > 0) return { ok: false, problems: fatal, warnings };

  const cacheName = cacheNameFor(build.buildId, build.assets);
  const config = { buildId: build.buildId, cachePrefix: CACHE_PREFIX, cacheName, shellUrl: SHELL_URL, assets: build.assets };
  const source = renderServiceWorker(await readFile(templatePath, "utf8"), config);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, source, "utf8");
  return { ok: true, problems: [], warnings, outPath, config, bytes: Buffer.byteLength(source) };
}

function parseArgs(argv) {
  const options = { allowMissingShell: process.env.QATRA_SW_ALLOW_MISSING_SHELL === "1" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-missing-shell") options.allowMissingShell = true;
    else if (arg === "--dist-dir") options.distDir = path.resolve(argv[(index += 1)]);
    else if (arg === "--public-dir") options.publicDir = path.resolve(argv[(index += 1)]);
    else if (arg === "--out") options.outPath = path.resolve(argv[(index += 1)]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await buildServiceWorker(parseArgs(process.argv.slice(2)));
    for (const warning of result.warnings) console.warn(`[build-sw] WARNING: ${warning}`);
    if (!result.ok) {
      console.error("[build-sw] The service worker was not written:");
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`[build-sw] wrote ${path.relative(process.cwd(), result.outPath)}: build ${result.config.buildId}, ${result.config.assets.length} files, ${result.bytes} bytes, cache ${result.config.cacheName}`);
  } catch (error) {
    console.error(`[build-sw] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
