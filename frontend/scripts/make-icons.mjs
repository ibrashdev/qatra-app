// Rasterises the install icons once; the PNGs are committed (offline decision G-08), so a build never needs a browser.
//   node scripts/make-icons.mjs
//
// The glyph is the droplet of the approved S-01 lockup (Lucide `Droplet`, as BrandMark.tsx draws it through Icon.tsx), white on the primary blue #1D78B5.
// Nothing is invented: the path is read from the installed lucide-react package, so the icon and the lockup cannot drift apart. The rasteriser is the
// Chromium that Playwright already installed for the e2e suite (no new dependency).
//   icon-192.png, icon-512.png   purpose "any": the glyph at about 56 % of the height
//   maskable-512.png              purpose "maskable": the glyph inside the 40 % safe zone (a circle of 80 % of the width), the rest is bleed
//   apple-touch-icon.png          180 x 180 for iOS, which rounds the corners itself

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BRAND_BLUE = "#1D78B5";
export const GLYPH = "#FFFFFF";

export const ICON_SPECS = [
  { file: "icon-192.png", size: 192, glyphShare: 0.62 },
  { file: "icon-512.png", size: 512, glyphShare: 0.62 },
  { file: "maskable-512.png", size: 512, glyphShare: 0.5 },
  { file: "apple-touch-icon.png", size: 180, glyphShare: 0.62 },
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "..");

// The droplet outline from the package that BrandMark uses. Throws instead of falling back to an invented shape.
export async function readDropletPath(root = frontendDir) {
  const file = path.join(root, "node_modules", "lucide-react", "dist", "esm", "icons", "droplet.mjs");
  const source = await readFile(file, "utf8");
  const match = /d:\s*"([^"]+)"/.exec(source);
  if (match === null) throw new Error(`The droplet path was not found in ${file}`);
  return match[1];
}

export function iconSvg({ size, glyphShare }, dropletPath) {
  const glyph = size * glyphShare;
  const offset = (size - glyph) / 2;
  const scale = glyph / 24;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${BRAND_BLUE}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})">` +
    `<path d="${dropletPath}" fill="none" stroke="${GLYPH}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</g></svg>`
  );
}

export async function makeIcons({ outDir = path.join(frontendDir, "public", "icons"), root = frontendDir } = {}) {
  const { chromium } = await import("@playwright/test");
  const dropletPath = await readDropletPath(root);
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const written = [];
    for (const spec of ICON_SPECS) {
      const page = await browser.newPage({ viewport: { width: spec.size, height: spec.size }, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:${BRAND_BLUE}">${iconSvg(spec, dropletPath)}</body></html>`);
      const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: spec.size, height: spec.size } });
      await page.close();
      const target = path.join(outDir, spec.file);
      await writeFile(target, png);
      written.push({ file: spec.file, size: spec.size, bytes: png.length });
    }
    return written;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = await makeIcons();
  for (const item of written) console.log(`wrote public/icons/${item.file} (${item.size}x${item.size}, ${item.bytes} bytes)`);
}
