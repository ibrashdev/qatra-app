import { MOCK_ADMIN } from "../../src/lib/api/mock";
import { expect, NAV_NAME, stubAdminApi, test, VIEWPORTS } from "./fixtures";

// The content manager screens (D91) in a real browser: the production build, the real same-origin fetch, the real envelope parsing, and the mock
// layer's synthetic data behind page.route. Nothing here reads a real book or any source text.

const E = MOCK_ADMIN.editions;
const S = MOCK_ADMIN.sections;

const ROUTES = ["/admin", "/admin/books", "/admin/categories", "/admin/sources", `/admin/editions/${E.published}`, `/admin/sections/${S.published}`];

test.describe("AD-00: the row in settings", () => {
  test.use({ viewport: VIEWPORTS.phone });

  test("a content manager sees the row, follows it, and the settings tab stays active", async ({ page }) => {
    await stubAdminApi(page);
    await page.goto("/settings");
    const row = page.getByRole("link", { name: "إدارة المحتوى" });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("href", "/admin");
    await row.click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("إدارة المحتوى");
    await expect(page.getByRole("navigation", { name: NAV_NAME.ar }).getByRole("link", { name: "الإعدادات" })).toHaveAttribute("aria-current", "page");
    await expect(page).toHaveTitle("إدارة المحتوى · قطرة غيث");
  });

  test("an account that is not a content manager sees no row and no error", async ({ page }) => {
    const stub = await stubAdminApi(page, { contentManager: false });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("الإعدادات");
    await expect(page.getByRole("link", { name: "الخصوصية والبيانات" })).toBeVisible();
    await expect.poll(() => stub.requests.filter((request) => request.path === "/admin/access").length).toBe(1);
    await expect(page.getByRole("link", { name: "إدارة المحتوى" })).toHaveCount(0);
    // Next's own route announcer is an empty alert; what counts is an alert that says something.
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
  });
});

test.describe("AD-01 to AD-06: Arabic, right to left, on a phone", () => {
  test.use({ viewport: VIEWPORTS.phone });

  test("AD-01 shows the note, the destinations with their counts, the AI card and the editions", async ({ page }) => {
    await stubAdminApi(page);
    await page.goto("/admin");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByText("التعديل هنا على بيانات العرض فقط. النص الأصلي لا يُعدَّل من هنا.")).toBeVisible();
    await expect(page.getByRole("link", { name: /^الكتب/ })).toHaveAttribute("href", "/admin/books");
    await expect(page.getByRole("link", { name: /^التصنيفات/ })).toHaveAttribute("href", "/admin/categories");
    await expect(page.getByRole("link", { name: /^مصادر المحتوى/ })).toHaveAttribute("href", "/admin/sources");
    await expect(page.getByRole("heading", { level: 2, name: "حالة الذكاء الاصطناعي" })).toBeVisible();
    await expect(page.getByText("للعرض فقط. الذكاء الاصطناعي لا يكتب المحتوى ولا يعدّله.")).toBeVisible();
    const editions = page.getByRole("link", { name: /كتاب تجريبي/ }).filter({ hasText: "الإصدار" });
    await expect(editions).toHaveCount(7);
    await editions.first().click();
    await expect(page).toHaveURL(/\/admin\/editions\//);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("تفاصيل الطبعة");
  });

  test.describe("a signed-in account that is not a content manager", () => {
    // Every admin read is answered 403, and the browser logs each failed request as a console error on its own.
    test.use({ allowFailedRequests: true });

    test("gets the single line on every admin route (403)", async ({ page }) => {
      await stubAdminApi(page, { contentManager: false });
      for (const route of ROUTES) {
        await page.goto(route);
        await expect(page.getByText("هذه الصفحة لمدير المحتوى فقط.")).toBeVisible();
        await expect(page.getByRole("link", { name: "العودة إلى الإعدادات" })).toBeVisible();
        await expect(page.getByRole("button", { name: /^(تعديل|حذف|سحب)/ })).toHaveCount(0);
      }
    });
  });

  test("a book that an edition uses cannot be deleted; an edit is saved with a toast", async ({ page }) => {
    const stub = await stubAdminApi(page);
    await page.goto("/admin/books");
    const used = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: "كتاب تجريبي أول" }) });
    const blocked = used.getByRole("button", { name: "حذف كتاب تجريبي أول" });
    await expect(blocked).toHaveAttribute("aria-disabled", "true");
    await expect(used.getByText("لا يمكن الحذف لأن عناصر أخرى تستخدم هذا العنصر.")).toBeVisible();
    // Playwright waits for an enabled button; this one is disabled the way the kit disables a button (aria-disabled), so the press is forced.
    await blocked.click({ force: true });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);

    await used.getByRole("button", { name: "تعديل كتاب تجريبي أول" }).click();
    const dialog = page.getByRole("dialog", { name: "تعديل الكتاب" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "العنوان بالعربية" })).toBeFocused();
    const author = dialog.getByRole("textbox", { name: "المؤلف" });
    await author.fill("مؤلف مختلف");
    await dialog.getByRole("button", { name: "حفظ" }).click();
    await expect(page.getByRole("status").getByText("تم حفظ التعديل")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(used.getByText("مؤلف مختلف")).toBeVisible();
    const patch = stub.requests.find((request) => request.method === "PATCH");
    expect(patch?.path).toBe(`/admin/books/${MOCK_ADMIN.books.first}`);
    expect(patch?.body).toEqual({ expectedUpdatedAt: "2026-10-05T08:00:00.000Z", author: "مؤلف مختلف" });
  });

  test("deleting a book nothing uses asks first in an alert dialog whose Cancel holds the focus", async ({ page }) => {
    const stub = await stubAdminApi(page);
    await page.goto("/admin/books");
    const free = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: "كتاب تجريبي بلا طبعات" }) });
    await free.getByRole("button", { name: "حذف كتاب تجريبي بلا طبعات" }).click();
    const dialog = page.getByRole("alertdialog", { name: "حذف الكتاب" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "إلغاء" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    expect(stub.requests.filter((request) => request.method === "POST")).toHaveLength(0);

    await free.getByRole("button", { name: "حذف كتاب تجريبي بلا طبعات" }).click();
    await dialog.getByRole("button", { name: "حذف الكتاب" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "كتاب تجريبي بلا طبعات" })).toHaveCount(0);
    await expect(page.getByRole("status").getByText("تم الحذف")).toBeVisible();
  });

  test("a source's license link must be https; the rights status is one of the three states", async ({ page }) => {
    const stub = await stubAdminApi(page);
    await page.goto("/admin/sources");
    const second = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: "مصدر تجريبي ثانٍ" }) });
    await second.getByRole("button", { name: "تعديل مصدر تجريبي ثانٍ" }).click();
    const dialog = page.getByRole("dialog", { name: "تعديل المصدر" });
    await dialog.getByRole("textbox", { name: "رابط الترخيص (اختياري)" }).fill("http://example.invalid/license");
    await dialog.getByRole("button", { name: "حفظ" }).click();
    await expect(dialog.getByText("يجب أن يبدأ الرابط بـ https://")).toBeVisible();
    expect(stub.requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
    await dialog.getByRole("textbox", { name: "رابط الترخيص (اختياري)" }).fill("https://example.invalid/license-two");
    await dialog.getByRole("combobox", { name: "حالة الحقوق" }).selectOption("verified");
    await dialog.getByRole("button", { name: "حفظ" }).click();
    await expect(second.getByText("تم التحقق")).toBeVisible();
  });

  test("categories are kept in display order, and an empty one can be deleted", async ({ page }) => {
    await stubAdminApi(page);
    await page.goto("/admin/categories");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["تصنيف تجريبي أول", "تصنيف تجريبي ثانٍ", "تصنيف تجريبي فارغ"]);
    const full = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: "تصنيف تجريبي أول" }) });
    await expect(full.getByRole("button", { name: "حذف تصنيف تجريبي أول" })).toHaveAttribute("aria-disabled", "true");
    await full.getByRole("button", { name: "تعديل تصنيف تجريبي أول" }).click();
    const dialog = page.getByRole("dialog", { name: "تعديل التصنيف" });
    await dialog.getByRole("textbox", { name: "ترتيب العرض" }).fill("٩");
    await dialog.getByRole("button", { name: "حفظ" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["تصنيف تجريبي ثانٍ", "تصنيف تجريبي فارغ", "تصنيف تجريبي أول"]);
  });

  test("the section page shows the units' text read only, in the Quran face for an ayah and the hadith face otherwise", async ({ page }) => {
    await stubAdminApi(page);
    await page.goto(`/admin/sections/${S.published}`);
    await expect(page.getByText("النص معروض كما في المصدر ولا يمكن تعديله.")).toBeVisible();
    const quran = page.getByText("نص تجريبي للوحدة الأولى");
    await expect(quran).toHaveAttribute("dir", "rtl");
    // Since D92 both faces use Scheherazade New, so the face is told apart by its class.
    await expect(quran).toHaveClass(/text-quran/);
    await expect(quran).toHaveCSS("font-family", /Scheherazade New/);
    await expect(page.getByRole("heading", { level: 2, name: "النص الأصلي" }).locator("..").getByRole("textbox")).toHaveCount(0);

    await page.goto(`/admin/sections/${S.hidden}`);
    const hadith = page.getByText("نص تجريبي للوحدة الأولى");
    await expect(hadith).toHaveClass(/text-hadith/);
    await expect(hadith).toHaveCSS("font-family", /Scheherazade New/);
    await expect(page.getByRole("link", { name: "رجوع إلى تفاصيل الطبعة" })).toHaveAttribute("href", `/admin/editions/${E.hidden}`);
  });
});

test.describe("AD-02: the edition's irreversible and reversible actions", () => {
  test.use({ viewport: VIEWPORTS.phone });

  test("withdrawing is an alert dialog that keeps the focus inside, starts on Cancel, and asks for a reason and a note", async ({ page }) => {
    const stub = await stubAdminApi(page);
    await page.goto(`/admin/editions/${E.published}`);
    await page.getByRole("button", { name: "سحب الطبعة" }).click();

    const dialog = page.getByRole("alertdialog", { name: "سحب الطبعة" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("سحب الطبعة نهائي ولا يمكن التراجع عنه. ستتوقف عن الظهور للمتعلمين.")).toBeVisible();
    // A real modal dialog: the browser matches :modal, and focus starts on the safe choice.
    expect(await page.evaluate(() => document.querySelector("dialog[open]")?.matches(":modal"))).toBe(true);
    await expect(dialog.getByRole("button", { name: "إلغاء" })).toBeFocused();
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null), `Tab ${press + 1} stays inside`).toBe(true);
    }

    await dialog.getByRole("button", { name: "سحب الطبعة نهائيًا" }).click();
    await expect(dialog.getByText("اختر سبب السحب.")).toBeVisible();
    expect(stub.requests.filter((request) => request.method === "POST")).toHaveLength(0);

    await dialog.getByRole("radio", { name: "الاعتماد العلمي" }).check();
    await dialog.getByRole("textbox", { name: "ملاحظة السحب" }).fill("سبب تجريبي للسحب");
    await dialog.getByRole("button", { name: "سحب الطبعة نهائيًا" }).click();

    await expect(page.getByRole("status").getByText("سُحبت الطبعة")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "سجل السحب" })).toBeVisible();
    await expect(page.getByRole("button", { name: "سحب الطبعة" })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    const post = stub.requests.find((request) => request.path === `/admin/editions/${E.published}/withdraw`);
    expect(post?.body).toEqual({ expectedUpdatedAt: "2026-10-05T08:00:00.000Z", reason: "accreditation", note: "سبب تجريبي للسحب" });
  });

  test("Escape closes the withdrawal dialog without sending and puts the focus back on its button", async ({ page }) => {
    const stub = await stubAdminApi(page);
    await page.goto(`/admin/editions/${E.published}`);
    const opener = page.getByRole("button", { name: "سحب الطبعة" });
    await opener.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(stub.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  test("hiding from the catalog is reversible and needs no dialog", async ({ page }) => {
    await stubAdminApi(page);
    await page.goto(`/admin/editions/${E.published}`);
    await page.getByRole("button", { name: "إخفاء من الفهرس" }).click();
    await expect(page.getByRole("status").getByText("أُخفيت الطبعة من الفهرس")).toBeVisible();
    await expect(page.getByText("مخفية من الفهرس").first()).toBeVisible();
    await page.getByRole("button", { name: "إظهار في الفهرس" }).click();
    await expect(page.getByRole("status").getByText("أُظهرت الطبعة في الفهرس")).toBeVisible();
    await expect(page.getByRole("button", { name: "إخفاء من الفهرس" })).toBeVisible();
  });

  // The stale answer is a 409, and the browser logs every failed request as a console error on its own.
  test.describe("a stale edit", () => {
    test.use({ allowFailedRequests: true });

    test("says the data changed, and the reload button reads it again", async ({ page }) => {
      const stub = await stubAdminApi(page);
      await page.goto(`/admin/editions/${E.published}`);
      // Another manager saved first: this page's token is now old.
      await page.evaluate(
        async ({ id }) => {
          await fetch(`/api/admin/editions/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedUpdatedAt: "2026-10-05T08:00:00.000Z", editionLabel: "طبعة أخرى" }),
          });
        },
        { id: E.published },
      );
      await page.getByRole("button", { name: "تغيير تسمية الطبعة" }).click();
      const dialog = page.getByRole("dialog", { name: "تغيير تسمية الطبعة" });
      await dialog.getByRole("textbox", { name: "تسمية الطبعة" }).fill("طبعة هذه الصفحة");
      await dialog.getByRole("button", { name: "حفظ" }).click();
      await expect(dialog.getByText("تغيّرت البيانات منذ فتح الصفحة. أعد التحميل ثم حاول مرة أخرى.")).toBeVisible();
      await dialog.getByRole("button", { name: "إعادة التحميل" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 2, name: "البيانات الأساسية" }).locator("../..").getByText("طبعة أخرى").first()).toBeVisible();
      expect(stub.requests.filter((request) => request.path === `/admin/editions/${E.published}` && request.method === "GET").length).toBeGreaterThanOrEqual(2);
    });
  });
});

test.describe("AD-01 to AD-06: English, left to right", () => {
  test.use({ viewport: VIEWPORTS.phone });

  test("the screens are written in English with the English titles", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("qatra.language", "en"));
    await stubAdminApi(page);
    await page.goto("/settings");
    await page.getByRole("link", { name: "Content management" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Content management");
    await page.getByRole("link", { name: /^Books/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Books");
    const first = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2, name: "Sample book one" }) });
    await expect(first.getByRole("button", { name: "Delete Sample book one" })).toHaveAttribute("aria-disabled", "true");
    await expect(first.getByText("It cannot be deleted because other items use it.")).toBeVisible();
  });
});

test.describe("AD-01 to AD-06 fit every supported width (D67)", () => {
  for (const language of ["ar", "en"] as const) {
    for (const width of [320, 390, 768, 1280]) {
      test(`${language} at ${width} px: no horizontal scroll, with and without a dialog open`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem("qatra.language", value), language);
        await stubAdminApi(page);
        await page.setViewportSize({ width, height: 800 });
        for (const route of ROUTES) {
          await page.goto(route);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
          const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
          expect(scrollWidth, `${route} at ${width}`).toBeLessThanOrEqual(clientWidth);
        }
        // The withdrawal dialog is the tallest and widest one.
        await page.goto(`/admin/editions/${E.published}`);
        await page.getByRole("button", { name: language === "ar" ? "سحب الطبعة" : "Withdraw the edition" }).click();
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        const box = await dialog.boundingBox();
        expect(box?.x ?? -1, "the dialog starts inside the viewport").toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), "and ends inside it").toBeLessThanOrEqual(width + 0.5);
        const confirm = dialog.getByRole("button", { name: language === "ar" ? "سحب الطبعة نهائيًا" : "Withdraw permanently" });
        await confirm.scrollIntoViewIfNeeded();
        await expect(confirm).toBeVisible();
      });
    }
  }
});
