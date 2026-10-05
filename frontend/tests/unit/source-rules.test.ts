// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|mjs|css)$/.test(entry) ? [full] : [];
  });
}

const sources = sourceFiles(path.join(root, "src"));
const tests = sourceFiles(path.join(root, "tests"));
// Separators are normalised to "/", so the rules read the same on Windows and Linux.
const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");

describe("the rules the screens keep, checked over the source (antislop D80, UI-tokens 1)", () => {
  it("has no em dash and no en dash in any new text: strings, comments, test names (R-02)", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
    const offenders = [...sources, ...tests].filter((file) => dashes.test(readFileSync(file, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });

  it("writes no colour value outside the token file: components read tokens only", () => {
    // themeColor of the viewport metadata cannot take a CSS variable, so that one literal is the documented exception.
    const allowed = new Map([["src/app/layout.tsx", 1]]);
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
    const offenders: string[] = [];
    for (const file of sources) {
      if (file.endsWith(path.join("styles", "tokens.css"))) continue;
      const count = (readFileSync(file, "utf8").match(literal) ?? []).length;
      if (count !== (allowed.get(relative(file)) ?? 0)) offenders.push(`${relative(file)} (${count})`);
    }
    expect(offenders).toEqual([]);
  });

  it("uses no utility from the default Tailwind palette, which the theme removes: it would style nothing", () => {
    const palette = /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|via)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/;
    expect(palette.test('className="bg-red-500 text-white"')).toBe(true); // the check can fail
    const offenders = sources.filter((file) => /\.tsx?$/.test(file) && palette.test(readFileSync(file, "utf8"))).map(relative);
    expect(offenders).toEqual([]);
  });

  it("uses logical properties only: no left, right, margin-left or padding-right utility", () => {
    const physical = /(?:^|[\s"'`:])-?(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)(?:-[\w[\]./()-]+)?(?=[\s"'`]|$)/;
    for (const sample of ["ml-4 flex", "flex pr-q8", "absolute left-0", "text-left", "border-l-2 p-q4", "hover:mr-q8"]) expect(physical.test(sample), sample).toBe(true); // the check can fail
    for (const sample of ["ms-auto flex", "pe-q4", "start-q16", "text-start", "border-s-2", "inset-s-0"]) expect(physical.test(sample), sample).toBe(false);
    const offenders: string[] = [];
    for (const file of sources.filter((entry) => /\.tsx$/.test(entry))) {
      const classNames = [...readFileSync(file, "utf8").matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((match) => match[1] ?? match[2] ?? "");
      if (classNames.some((value) => physical.test(value))) offenders.push(relative(file));
    }
    expect(offenders).toEqual([]);
  });

  it("imports the icon set in one place only, and only by name", () => {
    const importers = sources.filter((file) => /from "lucide-react"/.test(readFileSync(file, "utf8"))).map(relative);
    expect(importers).toEqual(["src/components/ui/Icon.tsx"]);
    const icon = readFileSync(path.join(root, "src/components/ui/Icon.tsx"), "utf8");
    expect(icon).not.toMatch(/import \* as/);
    expect(icon).not.toMatch(/lucide-react\/(?:dynamic|icons)/);
  });
});
