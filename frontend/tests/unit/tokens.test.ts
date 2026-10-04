// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../src/styles/tokens.css", import.meta.url), "utf8");

// The first :root block holds the base values; later blocks only override sizes and line heights.
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
const tokens = new Map<string, string>();
for (const match of rootBlock.matchAll(/(--q-[\w-]+):\s*([^;]+);/g)) tokens.set(match[1] as string, (match[2] as string).trim());

function color(name: string): string {
  const value = tokens.get(`--q-color-${name}`);
  if (value === undefined) throw new Error(`Missing token --q-color-${name}`);
  return value;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(foreground: string, background: string): number {
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const two = (value: number) => value.toFixed(2);

describe("design tokens (docs/UI-tokens.md 2.1 and 2.2)", () => {
  it("holds the approved palette without change", () => {
    const approved: Record<string, string> = {
      primary: "#1D78B5",
      "primary-deep": "#174F76",
      text: "#183B52",
      "text-secondary": "#536E82",
      "text-accent": "#174F76",
      bg: "#F5FAFE",
      surface: "#FFFFFF",
      selection: "#E6F4FD",
      border: "#7890A3",
      divider: "#D7E6F0",
      disabled: "#DFEAF2",
    };
    for (const [name, hex] of Object.entries(approved)) expect(color(name), name).toBe(hex);
  });

  it("is light only: color-scheme light and no dark media query", () => {
    expect(rootBlock).toContain("color-scheme: light");
    expect(css).not.toMatch(/prefers-color-scheme/);
  });

  it("uses the documented font stacks, with Cairo kept out of the religious stacks", () => {
    expect(tokens.get("--q-font-ui-ar")).toMatch(/^"Cairo"/);
    expect(tokens.get("--q-font-ui-en")).toMatch(/^"Inter"/);
    expect(tokens.get("--q-font-quran")).toMatch(/^"Amiri Quran"/);
    expect(tokens.get("--q-font-hadith")).toMatch(/^"Amiri"/);
    expect(tokens.get("--q-font-quran")).not.toContain("Cairo");
    expect(tokens.get("--q-font-hadith")).not.toContain("Cairo");
  });

  it("keeps the touch target at 44 px and nothing in the type scale below 13 px", () => {
    expect(tokens.get("--q-size-target")).toBe("2.75rem");
    for (const [name, value] of tokens) {
      if (name.endsWith("-size") && name.startsWith("--q-text-")) expect(Number.parseFloat(value) * 16, name).toBeGreaterThanOrEqual(13);
    }
  });
});

describe("contrast: the ratios of docs/UI-tokens.md 2.3, recomputed from tokens.css", () => {
  const page = () => color("bg");
  const surface = () => color("surface");
  const selection = () => color("selection");

  it("Table 1: approved colours on white, page and selection backgrounds", () => {
    const rows: [string, string, [string, string, string]][] = [
      ["text", "main text", ["11.76", "11.19", "10.48"]],
      ["text-secondary", "secondary text", ["5.36", "5.10", "4.78"]],
      ["primary-deep", "deep blue text", ["8.69", "8.27", "7.75"]],
      ["primary", "primary", ["4.77", "4.54", "4.25"]],
      ["border", "border", ["3.32", "3.16", "2.96"]],
    ];
    for (const [name, label, expected] of rows) {
      expect([surface(), page(), selection()].map((bg) => two(ratio(color(name), bg))), label).toEqual(expected);
    }
    // The two documented failures stay failures: they decide which colour may be used where.
    expect(ratio(color("primary"), selection())).toBeLessThan(4.5);
    expect(ratio(color("border"), selection())).toBeLessThan(3);
  });

  it("Table 2: fills and graphics", () => {
    const checks: [string, string, string][] = [
      [color("on-primary"), color("primary"), "4.77"],
      [color("on-primary"), color("primary-deep"), "8.69"],
      [color("on-primary"), color("primary-pressed"), "11.06"],
      [color("on-primary"), color("error-text"), "6.65"],
      [color("on-primary"), color("error-pressed"), "8.80"],
      [color("primary"), color("disabled"), "3.90"],
      [color("text"), color("disabled"), "9.62"],
      [color("on-primary"), color("inverse-bg"), "11.76"],
      [color("text-secondary"), color("disabled"), "4.38"],
    ];
    for (const [fg, bg, expected] of checks) expect(two(ratio(fg, bg)), `${fg} on ${bg}`).toBe(expected);
  });

  it("Table 3: status tokens on every background and on their own tint", () => {
    const rows: [string, string, [string, string, string, string]][] = [
      ["success-text", "success-bg", ["7.00", "6.66", "6.24", "6.16"]],
      ["success-border", "success-bg", ["5.25", "5.00", "4.68", "4.62"]],
      ["error-text", "error-bg", ["6.65", "6.33", "5.93", "5.81"]],
      ["error-border", "error-bg", ["5.52", "5.25", "4.92", "4.83"]],
      ["warning-text", "warning-bg", ["6.33", "6.02", "5.64", "5.79"]],
      ["warning-border", "warning-bg", ["5.19", "4.94", "4.63", "4.75"]],
    ];
    for (const [name, tint, expected] of rows) {
      const backgrounds = [surface(), page(), selection(), color(tint)];
      expect(backgrounds.map((bg) => two(ratio(color(name), bg))), name).toEqual(expected);
    }
  });

  it("Table 4: the focus ring reaches 3:1 on every colour it can touch", () => {
    const expected = ["8.69", "8.27", "7.75", "7.65", "7.60", "7.95", "7.11"];
    const backgrounds = ["surface", "bg", "selection", "success-bg", "error-bg", "warning-bg", "disabled"].map(color);
    expect(backgrounds.map((bg) => two(ratio(color("focus"), bg)))).toEqual(expected);
    for (const bg of backgrounds) expect(ratio(color("focus"), bg)).toBeGreaterThanOrEqual(3);
  });

  it("every text pairing the F0 shell uses reaches 4.5:1 (borders and indicators 3:1)", () => {
    const text: [string, string, string][] = [
      ["page title and body", "text", "bg"],
      ["placeholder line, busy line, tab labels", "text-secondary", "bg"],
      ["tab labels on the bar", "text-secondary", "surface"],
      ["active tab and rail label", "primary-deep", "surface"],
      ["active rail item", "primary-deep", "selection"],
      ["product name", "primary-deep", "bg"],
      ["selected language segment", "text-accent", "selection"],
      ["unselected language segment", "text", "surface"],
      ["wake-up banner", "info-text", "info-bg"],
      ["retry button", "primary-deep", "surface"],
      ["skip link", "on-primary", "inverse-bg"],
    ];
    for (const [label, fg, bg] of text) expect(ratio(color(fg), color(bg)), label).toBeGreaterThanOrEqual(4.5);

    const graphics: [string, string, string][] = [
      ["language segment border", "border", "surface"],
      ["selected segment border", "border-selected", "selection"],
      ["active tab indicator", "primary", "surface"],
      ["banner border", "info-border", "page"],
    ];
    for (const [label, fg, bg] of graphics) {
      const background = bg === "page" ? page() : color(bg);
      expect(ratio(color(fg), background), label).toBeGreaterThanOrEqual(3);
    }
  });
});
