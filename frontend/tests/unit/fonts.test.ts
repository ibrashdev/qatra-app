// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// Re-checks the coverage claim of docs/UI-tokens.md 3.2 against the installed Fontsource packages:
// Amiri Quran and Amiri contain the six Uthmani marks, Cairo contains none. Coverage only; shaping is
// checked by the Playwright screenshots (tests/e2e/fonts.spec.ts).
const MARKS = { U06E1: 0x06e1, U06E5: 0x06e5, U06E6: 0x06e6, U06E2: 0x06e2, U06ED: 0x06ed, U06DF: 0x06df };

const require = createRequire(import.meta.url);

function readWoff(packageName: string, file: string): Buffer {
  const manifest = require.resolve(`${packageName}/package.json`);
  return readFileSync(manifest.replace("package.json", `files/${file}`));
}

// Minimal WOFF 1.0 reader: the table directory, inflate the cmap table, then walk its formats 4 and 12.
function cmapCodePoints(woff: Buffer): Set<number> {
  if (woff.toString("latin1", 0, 4) !== "wOFF") throw new Error("not a WOFF 1.0 file");
  const tableCount = woff.readUInt16BE(12);
  let cmap: Buffer | null = null;
  for (let index = 0; index < tableCount; index += 1) {
    const entry = 44 + index * 20;
    if (woff.toString("latin1", entry, entry + 4) !== "cmap") continue;
    const offset = woff.readUInt32BE(entry + 4);
    const compressedLength = woff.readUInt32BE(entry + 8);
    const originalLength = woff.readUInt32BE(entry + 12);
    const raw = woff.subarray(offset, offset + compressedLength);
    cmap = compressedLength === originalLength ? raw : inflateSync(raw);
  }
  if (cmap === null) throw new Error("no cmap table");

  const points = new Set<number>();
  const subtables = cmap.readUInt16BE(2);
  for (let index = 0; index < subtables; index += 1) {
    const base = cmap.readUInt32BE(4 + index * 8 + 4);
    const format = cmap.readUInt16BE(base);
    if (format === 4) {
      const segments = cmap.readUInt16BE(base + 6) / 2;
      const endCodes = base + 14;
      const startCodes = endCodes + segments * 2 + 2;
      for (let segment = 0; segment < segments; segment += 1) {
        const end = cmap.readUInt16BE(endCodes + segment * 2);
        const start = cmap.readUInt16BE(startCodes + segment * 2);
        if (start === 0xffff) continue;
        for (let code = start; code <= end; code += 1) points.add(code);
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(base + 12);
      for (let group = 0; group < groups; group += 1) {
        const at = base + 16 + group * 12;
        const start = cmap.readUInt32BE(at);
        const end = cmap.readUInt32BE(at + 4);
        for (let code = start; code <= end; code += 1) points.add(code);
      }
    }
  }
  return points;
}

describe("original-text fonts (UI-tokens 3.1 and 3.2), checked in the installed packages", () => {
  it("Amiri Quran contains all six Uthmani marks", () => {
    const points = cmapCodePoints(readWoff("@fontsource/amiri-quran", "amiri-quran-arabic-400-normal.woff"));
    for (const [name, code] of Object.entries(MARKS)) expect(points.has(code), name).toBe(true);
  });

  it("Amiri contains all six Uthmani marks", () => {
    const points = cmapCodePoints(readWoff("@fontsource/amiri", "amiri-arabic-400-normal.woff"));
    for (const [name, code] of Object.entries(MARKS)) expect(points.has(code), name).toBe(true);
  });

  it("Cairo contains none of them, which is why it is never used for original text", () => {
    for (const weight of ["400", "600", "700"]) {
      const points = cmapCodePoints(readWoff("@fontsource/cairo", `cairo-arabic-${weight}-normal.woff`));
      for (const [name, code] of Object.entries(MARKS)) expect(points.has(code), `${name} in Cairo ${weight}`).toBe(false);
    }
  });

  it("the two original-text families are declared with font-display block and no other source than the package files", () => {
    const css = readFileSync(new URL("../../src/styles/fonts.css", import.meta.url), "utf8");
    const faces = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*block/);
      expect(face).toMatch(/url\("\.\.\/\.\.\/node_modules\/@fontsource\/amiri(-quran)?\/files\/[^"]+\.woff2"\)/);
      expect(face).not.toMatch(/https?:/);
    }
    expect(css).toContain('font-family: "Amiri Quran"');
    expect(css).toContain('font-family: "Amiri"');
  });

  it("the layout imports only the subset entry files of the Fontsource packages (no font CDN)", () => {
    const layout = readFileSync(new URL("../../src/app/layout.tsx", import.meta.url), "utf8");
    const imports = [...layout.matchAll(/import "(@fontsource\/[^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual([
      "@fontsource/cairo/arabic-400.css",
      "@fontsource/cairo/arabic-600.css",
      "@fontsource/cairo/arabic-700.css",
      "@fontsource/inter/latin-400.css",
      "@fontsource/inter/latin-600.css",
      "@fontsource/inter/latin-700.css",
    ]);
    expect(layout).not.toMatch(/fonts\.googleapis|fonts\.gstatic|next\/font\/google/);
  });
});
