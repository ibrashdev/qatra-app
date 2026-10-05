import type { Page } from "@playwright/test";
import { createMockFetch, MOCK_PASSWORD, mockCatalog, mockHandlers, withPlacementMock, type MockHandler } from "../../src/lib/api/mock";
import { controlHealth, expect, test, VIEWPORTS, waitForFirstHealthRequest } from "./fixtures";

// The core journey of Batch 2 in a real browser, against a production build in live mode: a learner with no plan signs in, chooses a book and a
// surah (S-08), skips the placement test (S-09), confirms the plan in the conversation (S-34), lands on today (S-11) and opens the session (S-19).
// Every /api/* answer comes from the app's own mock handlers (synthetic data only), run in the test process so the flow keeps its state;
// only E01 is left to the stub backend. Names and roles are used, never CSS.

const catalog: MockHandler = () => ({
  status: 200,
  body: {
    editions: mockCatalog.editions.map((edition) => ({
      ...edition,
      category:
        edition.contentFormat === "quran"
          ? { slug: "quran", labelAr: "القرآن الكريم", labelEn: "The Quran" }
          : { slug: "hadith", labelAr: "الحديث", labelEn: "Hadith" },
    })),
  },
});

// A visitor first: E11 answers 401 until the sign-in succeeds, and the sign-in of new_user_01 leaves the account with no plan.
async function serveMockBackend(page: Page) {
  const mockFetch = createMockFetch({
    latencyMs: 0,
    scenario: { signedIn: false, hasPlan: false },
    handlers: { ...withPlacementMock(mockHandlers), "GET /catalog": catalog },
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/api/health") return route.fallback();
    const answer = await mockFetch(request.url(), { method: request.method(), body: request.postData() ?? undefined });
    const body = await answer.text();
    await route.fulfill({ status: answer.status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, ...(body === "" ? {} : { body }) });
  });
}

test("sign in without a plan, choose a surah, skip the test, confirm the plan, and open today's session", async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.phone);
  const health = await controlHealth(page, "ok");
  await serveMockBackend(page);

  // S-01: the account has no plan, so the sign-in leads to S-08.
  await page.goto("/login");
  await waitForFirstHealthRequest(health);
  await page.getByRole("textbox", { name: "اسم المستخدم" }).fill("new_user_01");
  await page.getByLabel("كلمة المرور", { exact: true }).fill(MOCK_PASSWORD);
  await page.getByRole("button", { name: "دخول", exact: true }).click();

  // S-08: the Quran category, by surah, one surah, then the start button.
  await expect(page).toHaveURL(/\/start$/);
  await expect(page.getByRole("heading", { level: 1, name: "ما هي خطتك؟" })).toBeVisible();
  await page.getByRole("radio", { name: "القرآن الكريم" }).check();
  await page.getByRole("radio", { name: "حسب السورة" }).check();
  await page.getByRole("checkbox", { name: /عنصر نائب\) ١/ }).check();
  const startButton = page.getByRole("button", { name: "ابدأ المحادثة" });
  await expect(startButton).toHaveAttribute("aria-disabled", "false");
  await startButton.click();

  // S-09: skip the placement test and go on to the plan.
  await expect(page).toHaveURL(/\/placement$/);
  await page.getByRole("button", { name: "تخطي الاختبار" }).click();
  await page.getByRole("dialog", { name: "تخطي الاختبار؟" }).getByRole("button", { name: "تخطي والمتابعة إلى الخطة" }).click();

  // S-34: the plan conversation offers a proposal, and confirming it ends the conversation.
  await expect(page).toHaveURL(/\/plan\/chat\/[0-9a-f-]{36}$/);
  const confirm = page.getByRole("button", { name: "اعتماد الخطة", exact: true });
  await expect(confirm).toBeVisible();
  await confirm.click();

  // S-11: today shows the confirmation toast and the button that opens the session.
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("status").filter({ hasText: "تم اعتماد خطتك." })).toBeVisible();
  await page.getByRole("button", { name: "ابدأ جلسة اليوم" }).click();

  // S-19: the session screen is open.
  await expect(page).toHaveURL(/\/session\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: "جلسة الحفظ" })).toBeVisible();
});
