import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { controlHealth, expect, test, VIEWPORTS, waitForFirstHealthRequest } from "./fixtures";

// A neutral letter carrying each of the six Uthmani marks (U+06E1, U+06E5, U+06E6, U+06E2, U+06ED, U+06DF).
// Synthetic: no source text. The marks are the only thing under test (UI-tokens 3.2, contract section 1).
const MARK_SAMPLE = "بۡ بۥ بۦ بۢ بۭ ب۟";

test.describe("self-hosted fonts: no font CDN, no other origin", () => {
  test("every request of every shell route stays on the app origin", async ({ page, baseURL }) => {
    const foreign: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith(baseURL as string) && !url.startsWith("data:") && !url.startsWith("blob:")) foreign.push(url);
    });
    for (const language of ["ar", "en"]) {
      await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
      for (const route of ["/login", "/today", "/games"]) {
        await page.goto(route);
        await page.evaluate(() => document.fonts.ready);
      }
    }
    expect(foreign).toEqual([]);
  });

  test("Cairo serves the Arabic UI and Inter the English UI, from /_next/static/media", async ({ page }) => {
    const fontUrls: string[] = [];
    page.on("response", (response) => {
      if (/\.woff2?(\?|$)/.test(response.url())) fontUrls.push(new URL(response.url()).pathname);
    });
    await page.goto("/login");
    await page.evaluate(() => document.fonts.ready);
    const arabic = await page.evaluate(() => [...document.fonts].filter((face) => face.status === "loaded").map((face) => `${face.family} ${face.weight}`));
    expect(arabic.some((entry) => entry.startsWith("Cairo"))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^Cairo/);

    await page.getByRole("radio", { name: "English (EN)" }).check();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^Inter/);
    await expect
      .poll(async () => page.evaluate(() => [...document.fonts].some((face) => face.family.replace(/"/g, "") === "Inter" && face.status === "loaded")))
      .toBe(true);

    expect(fontUrls.length).toBeGreaterThan(0);
    for (const path of fontUrls) expect(path).toMatch(/^\/_next\/static\/media\//);
  });
});

test.describe("original-text fonts render the six Uthmani marks (screenshots attached for review)", () => {
  for (const language of ["ar", "en"] as const) {
    for (const [name, viewport] of [
      ["360x780", VIEWPORTS.phoneSmall],
      ["390x844", VIEWPORTS.phone],
      ["1280x800", VIEWPORTS.desktop],
    ] as const) {
      test(`${language} interface at ${name}`, async ({ page }, testInfo) => {
        await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
        await page.setViewportSize(viewport);
        const health = await controlHealth(page, "ok");
        await page.goto("/login");
        // Hydration is over once the first health request has been issued; injecting earlier would break it.
        await waitForFirstHealthRequest(health);
        await page.evaluate((sample) => {
          const host = document.createElement("div");
          host.id = "mark-sample";
          host.style.cssText = "padding:16px;background:#fff;display:grid;gap:16px";
          for (const [label, family, size, lh] of [
            ["quran", "var(--q-font-quran)", "var(--q-text-quran-size)", "var(--q-text-quran-lh)"],
            ["hadith", "var(--q-font-hadith)", "var(--q-text-hadith-size)", "var(--q-text-hadith-lh)"],
          ]) {
            const line = document.createElement("p");
            line.dataset.sample = label;
            line.lang = "ar";
            line.dir = "rtl";
            line.textContent = sample;
            line.style.cssText = `font-family:${family};font-size:${size};line-height:${lh};margin:0;overflow:visible;letter-spacing:0;font-synthesis:none;text-align:start`;
            host.append(line);
          }
          document.querySelector("main")?.append(host);
        }, MARK_SAMPLE);
        await page.evaluate(async (sample) => {
          await Promise.all([document.fonts.load('26px "Amiri Quran"', sample), document.fonts.load('24px "Amiri"', sample)]);
          await document.fonts.ready;
        }, MARK_SAMPLE);

        const loaded = await page.evaluate(() => [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replace(/"/g, "")));
        expect(loaded).toContain("Amiri Quran");
        expect(loaded).toContain("Amiri");

        // The rendered family is the original-text font, and nothing clipped the marks.
        for (const kind of ["quran", "hadith"]) {
          const line = page.locator(`[data-sample=${kind}]`);
          const info = await line.evaluate((element) => {
            const style = getComputedStyle(element);
            return { family: style.fontFamily, overflow: style.overflow, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
          });
          expect(info.family).toMatch(kind === "quran" ? /^"Amiri Quran"/ : /^Amiri/);
          expect(info.overflow).toBe("visible");
          expect(info.scrollWidth).toBeLessThanOrEqual(info.clientWidth);
        }
        const buffer = await page.locator("#mark-sample").screenshot();
        await testInfo.attach(`marks-${language}-${name}.png`, { body: buffer, contentType: "image/png" });
        // Kept on disk for the manual review that UI-tokens 3.2 asks for; Playwright drops attachments of passing tests.
        const reviewDir = path.join(process.cwd(), "marks-review");
        mkdirSync(reviewDir, { recursive: true });
        writeFileSync(path.join(reviewDir, `marks-${language}-${name}.png`), buffer);
      });
    }
  }
});
