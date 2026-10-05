import type { Locator, Page } from "@playwright/test";
import { axeViolations, controlHealth, expect, smallTargets, test, VIEWPORTS, waitForFirstHealthRequest } from "./fixtures";

// The selected segment of the language switch carries a check at the start edge (UI-screens P-02, UI-tokens 6.0 "Selected": never colour alone),
// seen in a real browser on a screen with a back control (S-03) and on one without (S-01).

type Language = "ar" | "en";

// The accessible names of the two radios, the same in both interface languages.
const NAME = { ar: "العربية", en: "English (EN)" } as const;
const BACK = { ar: "رجوع إلى الصفحة الرئيسية", en: "Back to Home" } as const;
const ACCENT = "rgb(23, 79, 118)";

async function open(page: Page, path: string, { language = "ar", viewport = VIEWPORTS.phone }: { language?: Language; viewport?: { width: number; height: number } } = {}) {
  await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
  await page.setViewportSize(viewport);
  const health = await controlHealth(page, "ok");
  await page.goto(path);
  await waitForFirstHealthRequest(health);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("no bounding box");
  return result;
}

const group = (page: Page) => page.getByRole("banner").getByRole("radiogroup");
// A segment is the label around its radio.
const segment = (page: Page, language: "ar" | "en") => page.getByRole("radio", { name: NAME[language] }).locator("xpath=ancestor::label");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const path of ["/terms", "/login"]) {
  test.describe(`the check on the selected segment of the language switch, on ${path}`, () => {
    for (const language of ["ar", "en"] as const) {
      test(`${language}: only the selected segment has a check, at the start edge before its label, decorative, 16 px, in the accent colour`, async ({ page }) => {
        await open(page, path, { language });
        const selected = segment(page, language);
        const other = segment(page, language === "ar" ? "en" : "ar");
        await expect(selected.locator("svg")).toHaveCount(1);
        await expect(other.locator("svg")).toHaveCount(0);
        const check = selected.locator("svg");
        await expect(check).toHaveAttribute("aria-hidden", "true");
        await expect(check).toHaveAttribute("focusable", "false");
        const computed = await check.evaluate((svg) => {
          const style = getComputedStyle(svg);
          return { width: style.width, height: style.height, color: style.color, strokeWidth: style.strokeWidth, transform: style.transform };
        });
        expect(computed).toEqual({ width: "16px", height: "16px", color: ACCENT, strokeWidth: "2px", transform: "none" });

        // The start edge is the right in Arabic and the left in English: the glyph sits on that side of the label text.
        const { glyph, text } = await selected.evaluate((label) => {
          const svg = (label.querySelector("svg") as SVGElement).getBoundingClientRect();
          const node = [...label.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "") as Node;
          const range = document.createRange();
          range.selectNodeContents(node);
          const words = range.getBoundingClientRect();
          return { glyph: svg.x + svg.width / 2, text: words.x + words.width / 2 };
        });
        if (language === "ar") expect(glyph).toBeGreaterThan(text);
        else expect(glyph).toBeLessThan(text);
      });

      test(`${language}: the check moves with the choice, the names do not change, and the two segments keep the height of a target`, async ({ page }) => {
        await open(page, path, { language });
        const names = () => page.getByRole("radio").evaluateAll((radios) => radios.map((radio) => radio.getAttribute("aria-label")));
        const before = await names();
        expect(before).toEqual([NAME.ar, NAME.en]);

        const target: Language = language === "ar" ? "en" : "ar";
        await page.getByRole("radio", { name: NAME[target] }).check();
        await expect(page.locator("html")).toHaveAttribute("lang", target);
        await expect(segment(page, target).locator("svg")).toHaveCount(1);
        await expect(segment(page, language).locator("svg")).toHaveCount(0);
        expect(await names()).toEqual(before);
        for (const side of ["ar", "en"] as const) expect(Math.round((await box(segment(page, side))).height), side).toBe(44);
        expect(await smallTargets(page)).toEqual([]);
        // Focus stays on the switch and the keyboard still moves the choice.
        await expect(page.getByRole("radio", { name: NAME[target] })).toBeFocused();
        await page.keyboard.press(target === "ar" ? "ArrowLeft" : "ArrowRight");
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        await expect(segment(page, language).locator("svg")).toHaveCount(1);
      });

      test(`${language}: the segments keep the order of the spec, Arabic then English, with the check inside the selected one's border`, async ({ page }) => {
        await open(page, path, { language });
        const ar = await box(segment(page, "ar"));
        const en = await box(segment(page, "en"));
        // Right to left in Arabic, left to right in English: the same logical order, so «العربية» is first in the reading direction.
        if (language === "ar") expect(ar.x).toBeGreaterThan(en.x);
        else expect(ar.x).toBeLessThan(en.x);
        const selected = segment(page, language);
        const outer = await box(selected);
        const check = await box(selected.locator("svg"));
        expect(check.x).toBeGreaterThanOrEqual(outer.x);
        expect(check.x + check.width).toBeLessThanOrEqual(outer.x + outer.width);
        expect(check.y).toBeGreaterThanOrEqual(outer.y);
        expect(check.y + check.height).toBeLessThanOrEqual(outer.y + outer.height);
      });
    }
  });
}

test.describe("the header with the back control and the switch at small widths and large text (S-03 and every public screen with a back control)", () => {
  for (const language of ["ar", "en"] as const) {
    test(`${language}: at 320 px the back control and the switch share one row and neither overlaps the other`, async ({ page }) => {
      await open(page, "/terms", { language, viewport: VIEWPORTS.floor });
      const back = await box(page.getByRole("link", { name: BACK[language], exact: true }));
      const switchBox = await box(group(page));
      expect(Math.abs(back.y + back.height / 2 - (switchBox.y + switchBox.height / 2)), "one row").toBeLessThanOrEqual(1);
      if (language === "ar") expect(back.x).toBeGreaterThanOrEqual(switchBox.x + switchBox.width);
      else expect(switchBox.x).toBeGreaterThanOrEqual(back.x + back.width);
      expect(switchBox.x).toBeGreaterThanOrEqual(0);
      expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(VIEWPORTS.floor.width);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
    });

    test(`${language}: at 150 % text on 320 px the bar wraps into two rows, the switch under the back control at the end edge, with nothing outside the page`, async ({ page }) => {
      await open(page, "/terms", { language, viewport: VIEWPORTS.floor });
      await page.addStyleTag({ content: "html { font-size: 150% !important; }" });
      const back = await box(page.getByRole("link", { name: BACK[language], exact: true }));
      const switchBox = await box(group(page));
      expect(switchBox.y).toBeGreaterThanOrEqual(back.y + back.height - 1);
      expect(switchBox.x).toBeGreaterThanOrEqual(0);
      expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(VIEWPORTS.floor.width);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test(`${language}: at 200 % text on 320 px the bar wraps cleanly: the segments stack when both no longer fit, nothing leaves the page or overlaps`, async ({ page }) => {
      await open(page, "/terms", { language, viewport: { width: 320, height: 568 } });
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      const back = await box(page.getByRole("link", { name: BACK[language], exact: true }));
      const first = await box(segment(page, "ar"));
      const second = await box(segment(page, "en"));
      // The back control is on its own row, and every segment is inside the page, whole, with no overlap between them.
      for (const part of [back, first, second]) {
        expect(part.x).toBeGreaterThanOrEqual(0);
        expect(part.x + part.width).toBeLessThanOrEqual(320);
      }
      expect(Math.min(first.y, second.y)).toBeGreaterThanOrEqual(back.y + back.height - 1);
      const overlap = first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height;
      expect(overlap, "the segments do not overlap").toBe(false);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test("at 200 % text on 360 px the switch has no horizontal scroll either, on a screen without a back control", async ({ page }) => {
    await open(page, "/login", { viewport: { width: 360, height: 640 } });
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await expect(page.getByRole("radio", { name: NAME.ar })).toBeVisible();
    await expect(page.getByRole("radio", { name: NAME.en })).toBeVisible();
  });
});
