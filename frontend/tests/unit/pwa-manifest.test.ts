// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import nextConfig from "../../next.config";
import { BRAND_BLUE, ICON_SPECS, iconSvg, readDropletPath } from "../../scripts/make-icons.mjs";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the web app manifest (public, nothing personal)", () => {
  const value = manifest();

  it("names the app, starts at the public shell, and stays standalone and RTL", () => {
    expect(value).toMatchObject({ name: "قطرة غيث", short_name: "قطرة غيث", start_url: "/offline", scope: "/", display: "standalone", lang: "ar", dir: "rtl", id: "/qatra" });
    expect(value.background_color).toBe("#F5FAFE");
    expect(value.theme_color).toBe("#F5FAFE");
  });

  it("lists 192 and 512 icons and a maskable 512 icon", () => {
    expect(value.icons).toEqual([
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  it("carries no account id, plan, query or token in any field", () => {
    const text = JSON.stringify(value);
    expect(text).not.toMatch(/[?&=]|userId|planId|token|session|eyJ/i);
    for (const url of [value.start_url, value.scope, value.id, ...(value.icons ?? []).map((icon) => icon.src)]) expect(String(url)).not.toMatch(/[?#]/);
  });
});

describe("the committed install icons (offline decision G-08)", () => {
  it.each(ICON_SPECS)("$file is a real PNG of $size x $size", async ({ file, size }) => {
    const bytes = await readFile(path.join(frontendDir, "public", "icons", file));
    expect(pngSize(bytes)).toEqual({ width: size, height: size });
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("the manifest and the layout point at files that exist", async () => {
    for (const icon of manifest().icons ?? []) await expect(readFile(path.join(frontendDir, "public", ...icon.src.split("/").filter(Boolean)))).resolves.toBeDefined();
    const layout = await readFile(path.join(frontendDir, "src", "app", "layout.tsx"), "utf8");
    expect(layout).toContain("/icons/icon-192.png");
    expect(layout).toContain("/icons/apple-touch-icon.png");
    expect(layout).toContain("appleWebApp");
    expect(layout).toContain("<PwaBootstrap />");
    expect(layout).not.toContain('"data:,"');
  });

  it("the glyph is the droplet Lucide ships (the one the S-01 lockup draws), white on the brand blue, and the maskable one keeps a 40% safe zone", async () => {
    const dropletPath = await readDropletPath(frontendDir);
    expect(dropletPath).toMatch(/^M12 22a7 7 0 0 0 7-7/);
    const maskable = ICON_SPECS.find((spec) => spec.file === "maskable-512.png");
    const any = ICON_SPECS.find((spec) => spec.file === "icon-512.png");
    expect(maskable?.glyphShare).toBeLessThanOrEqual(0.5);
    expect(any?.glyphShare).toBeLessThanOrEqual(0.62);
    const svg = iconSvg(maskable as { size: number; glyphShare: number }, dropletPath);
    expect(svg).toContain(`fill="${BRAND_BLUE}"`);
    expect(svg).toContain(dropletPath);
    expect(BRAND_BLUE).toBe("#1D78B5");
  });
});

describe("headers for /sw.js (offline-spec 3.1)", () => {
  it("is never cached, is JavaScript, restricts its own scripts to this origin and may control the whole site", async () => {
    const blocks = (await nextConfig.headers?.()) ?? [];
    const block = blocks.find((entry) => entry.source === "/sw.js");
    const headers = Object.fromEntries((block?.headers ?? []).map((header) => [header.key, header.value]));
    expect(headers).toEqual({
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Type": "application/javascript; charset=utf-8",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      "Service-Worker-Allowed": "/",
    });
  });

  it("adds no header to any other path (the Quran-audio block is added beside this one later)", async () => {
    const blocks = (await nextConfig.headers?.()) ?? [];
    expect(blocks.map((entry) => entry.source)).toEqual(["/sw.js"]);
  });
});
