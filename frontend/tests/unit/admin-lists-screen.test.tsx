import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/books", useRouter: () => navigation.router }));

import { BooksScreen } from "@/components/admin/BooksScreen";
import { CategoriesScreen } from "@/components/admin/CategoriesScreen";
import { ContentSourcesScreen } from "@/components/admin/ContentSourcesScreen";
import { MOCK_ADMIN } from "@/lib/api/mock/admin-handlers";
import { errorResponse, type MockHandler } from "@/lib/api/mock/handlers";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { cleanupAdmin, renderAdmin, type AdminRender } from "./admin-support";
import { installDialogPolyfill } from "./dialog-polyfill";

const SEED_STAMP = "2026-10-05T08:00:00.000Z";
const NEVER_SHOWN = "a message that is never shown";
const IN_USE = "لا يمكن الحذف لأن عناصر أخرى تستخدم هذا العنصر.";

let rendered: AdminRender | undefined;

function renderList(ui: React.ReactElement, options: Parameters<typeof renderAdmin>[1] = {}) {
  rendered = renderAdmin(ui, options);
  return rendered;
}

const conflict = (reason: string): MockHandler => () => errorResponse(409, "version_conflict", NEVER_SHOWN, { reason });

// The card of a row, found by its title (the heading of the card).
const card = async (title: string) => (await screen.findByRole("heading", { level: 2, name: title })).closest("li") as HTMLElement;

beforeEach(() => {
  installDialogPolyfill();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  clearLoginArrival();
});

afterEach(() => {
  cleanupAdmin(rendered);
  rendered = undefined;
});

describe("AD-04 Books", () => {
  it("lists every book with its author, category, content type and edition count", async () => {
    renderList(<BooksScreen />);
    expect(await screen.findByRole("heading", { level: 1, name: "الكتب" })).toBeInTheDocument();
    const first = await card("كتاب تجريبي أول");
    expect(within(first).getByText("المؤلف:").nextElementSibling).toHaveTextContent("مؤلف تجريبي أول");
    expect(within(first).getByText("التصنيف:").nextElementSibling).toHaveTextContent("تصنيف تجريبي أول");
    expect(within(first).getByText("نوع المحتوى:").nextElementSibling).toHaveTextContent("نص قرآني");
    expect(within(first).getByText("عدد الطبعات:").nextElementSibling).toHaveTextContent("٣");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
    expect(screen.getByRole("link", { name: "رجوع إلى إدارة المحتوى" })).toHaveAttribute("href", "/admin");
  });

  it("disables the delete of a book that an edition uses, names the reason as its description, and does nothing when it is pressed", async () => {
    const user = userEvent.setup();
    const view = renderList(<BooksScreen />);
    const used = await card("كتاب تجريبي أول");
    const button = within(used).getByRole("button", { name: "حذف كتاب تجريبي أول" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(IN_USE);
    await user.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(view.calls.filter((call) => call.key.startsWith("POST"))).toHaveLength(0);

    const free = await card("كتاب تجريبي بلا طبعات");
    expect(within(free).getByRole("button", { name: "حذف كتاب تجريبي بلا طبعات" })).not.toHaveAttribute("aria-disabled");
    expect(within(free).queryByText(IN_USE)).toBeNull();
  });

  it("asks before deleting a book nothing uses, with Cancel holding the focus, then deletes once and removes it", async () => {
    const user = userEvent.setup();
    const view = renderList(<BooksScreen />);
    const free = await card("كتاب تجريبي بلا طبعات");
    await user.click(within(free).getByRole("button", { name: "حذف كتاب تجريبي بلا طبعات" }));

    const dialog = await screen.findByRole("alertdialog", { name: "حذف الكتاب" });
    expect(dialog).toHaveTextContent("سيُحذف الكتاب كتاب تجريبي بلا طبعات نهائيًا. لا يمكن التراجع عن ذلك.");
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "إلغاء" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(view.calls.filter((call) => call.key.startsWith("POST"))).toHaveLength(0);

    await user.click(within(await card("كتاب تجريبي بلا طبعات")).getByRole("button", { name: "حذف كتاب تجريبي بلا طبعات" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "حذف الكتاب" }));
    await waitFor(() => expect(view.sent(`POST /admin/books/${MOCK_ADMIN.books.unused}/delete`)).toHaveLength(1));
    expect(view.sent(`POST /admin/books/${MOCK_ADMIN.books.unused}/delete`)[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP });
    expect(await screen.findByText("تم الحذف")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "كتاب تجريبي بلا طبعات" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "الكتب" })).toHaveFocus());
  });

  it("edits the author and the category and sends only those, with the token, then shows the saved book and a toast", async () => {
    const user = userEvent.setup();
    const view = renderList(<BooksScreen />);
    await user.click(within(await card("كتاب تجريبي أول")).getByRole("button", { name: "تعديل كتاب تجريبي أول" }));

    const dialog = await screen.findByRole("dialog", { name: "تعديل الكتاب" });
    expect(within(dialog).getByRole("textbox", { name: "العنوان بالعربية" })).toHaveFocus();
    expect(within(dialog).getByRole("textbox", { name: "العنوان بالإنجليزية (اختياري)" })).toHaveValue("Sample book one");
    const author = within(dialog).getByRole("textbox", { name: "المؤلف" });
    await user.clear(author);
    await user.type(author, "مؤلف مختلف");
    const category = within(dialog).getByRole("combobox", { name: "التصنيف" });
    expect(category).toHaveValue(MOCK_ADMIN.categories.first);
    await user.selectOptions(category, MOCK_ADMIN.categories.second);
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));

    await waitFor(() => expect(view.sent(`PATCH /admin/books/${MOCK_ADMIN.books.first}`)).toHaveLength(1));
    expect(view.sent(`PATCH /admin/books/${MOCK_ADMIN.books.first}`)[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP, author: "مؤلف مختلف", categoryId: MOCK_ADMIN.categories.second });
    expect(await screen.findByText("تم حفظ التعديل")).toBeInTheDocument();
    const saved = await card("كتاب تجريبي أول");
    expect(within(saved).getByText("المؤلف:").nextElementSibling).toHaveTextContent("مؤلف مختلف");
    expect(within(saved).getByText("التصنيف:").nextElementSibling).toHaveTextContent("تصنيف تجريبي ثانٍ");
  });

  it("judges the fields before sending, and sends a cleared English title as null", async () => {
    const user = userEvent.setup();
    const view = renderList(<BooksScreen />);
    await user.click(within(await card("كتاب تجريبي أول")).getByRole("button", { name: "تعديل كتاب تجريبي أول" }));
    const dialog = await screen.findByRole("dialog");

    const arabic = within(dialog).getByRole("textbox", { name: "العنوان بالعربية" });
    await user.clear(arabic);
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("هذا الحقل مطلوب.")).toBeInTheDocument();
    expect(view.sent(`PATCH /admin/books/${MOCK_ADMIN.books.first}`)).toHaveLength(0);

    await user.type(arabic, "كتاب تجريبي أول");
    await user.clear(within(dialog).getByRole("textbox", { name: "العنوان بالإنجليزية (اختياري)" }));
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    await waitFor(() => expect(view.sent(`PATCH /admin/books/${MOCK_ADMIN.books.first}`)).toHaveLength(1));
    expect(view.sent(`PATCH /admin/books/${MOCK_ADMIN.books.first}`)[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP, titleEn: null });
  });

  it("says the data changed and reads the list again when the book is stale", async () => {
    const user = userEvent.setup();
    const view = renderList(<BooksScreen />, { handlers: { [`PATCH /admin/books/${MOCK_ADMIN.books.first}`]: conflict("stale") } });
    await user.click(within(await card("كتاب تجريبي أول")).getByRole("button", { name: "تعديل كتاب تجريبي أول" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "المؤلف" }), "!");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("تغيّرت البيانات منذ فتح الصفحة. أعد التحميل ثم حاول مرة أخرى.")).toBeInTheDocument();
    expect(screen.queryByText(NEVER_SHOWN)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "إعادة التحميل" }));
    await waitFor(() => expect(view.count("GET /admin/books")).toBe(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says why when the server refuses a delete because the book is in use", async () => {
    const user = userEvent.setup();
    renderList(<BooksScreen />, { handlers: { [`POST /admin/books/${MOCK_ADMIN.books.unused}/delete`]: conflict("in_use") } });
    await user.click(within(await card("كتاب تجريبي بلا طبعات")).getByRole("button", { name: "حذف كتاب تجريبي بلا طبعات" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "حذف الكتاب" }));
    // The rows that are in use carry the same sentence under their button, so the answer of the server is found as the alert.
    expect(await screen.findByRole("alert")).toHaveTextContent(IN_USE);
    expect(screen.getByRole("heading", { level: 2, name: "كتاب تجريبي بلا طبعات" })).toBeInTheDocument();
  });

  it("shows only the line for a content manager for an account that is not one (403)", async () => {
    renderList(<BooksScreen />, { scenario: { contentManager: false } });
    expect(await screen.findByText("هذه الصفحة لمدير المحتوى فقط.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByRole("button", { name: /^تعديل/ })).toBeNull();
  });

  it("returns to sign-in with the page as `next` when the session ended (401)", async () => {
    renderList(<BooksScreen />, { scenario: { signedIn: false } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fadmin%2Fbooks"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("is written in English with the English titles", async () => {
    renderList(<BooksScreen />, { language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Books" })).toBeInTheDocument();
    const first = await card("Sample book one");
    expect(within(first).getByText("Author:")).toBeInTheDocument();
    expect(within(first).getByRole("button", { name: "Delete Sample book one" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("AD-05 Categories", () => {
  it("lists the categories in display order with their slug, order and book count", async () => {
    renderList(<CategoriesScreen />);
    expect(await screen.findByRole("heading", { level: 1, name: "التصنيفات" })).toBeInTheDocument();
    const first = await card("تصنيف تجريبي أول");
    expect(within(first).getByText("المعرّف:").nextElementSibling).toHaveTextContent("sample-first");
    expect(within(first).getByText("ترتيب العرض:").nextElementSibling).toHaveTextContent("١");
    expect(within(first).getByText("عدد الكتب:").nextElementSibling).toHaveTextContent("٢");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["تصنيف تجريبي أول", "تصنيف تجريبي ثانٍ", "تصنيف تجريبي فارغ"]);
  });

  it("deletes only an empty category: the others have a disabled button with the reason", async () => {
    const user = userEvent.setup();
    const view = renderList(<CategoriesScreen />);
    const full = await card("تصنيف تجريبي أول");
    const blocked = within(full).getByRole("button", { name: "حذف تصنيف تجريبي أول" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAccessibleDescription(IN_USE);

    await user.click(within(await card("تصنيف تجريبي فارغ")).getByRole("button", { name: "حذف تصنيف تجريبي فارغ" }));
    const dialog = await screen.findByRole("alertdialog", { name: "حذف التصنيف" });
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "حذف التصنيف" }));
    await waitFor(() => expect(view.sent(`POST /admin/categories/${MOCK_ADMIN.categories.empty}/delete`)).toHaveLength(1));
    expect(await screen.findByText("تم الحذف")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("reads the display order in Arabic digits, sends it as a number, and moves the row to its new place", async () => {
    const user = userEvent.setup();
    const view = renderList(<CategoriesScreen />);
    await user.click(within(await card("تصنيف تجريبي أول")).getByRole("button", { name: "تعديل تصنيف تجريبي أول" }));
    const dialog = await screen.findByRole("dialog", { name: "تعديل التصنيف" });
    const order = within(dialog).getByRole("textbox", { name: "ترتيب العرض" });
    expect(order).toHaveValue("1");
    expect(order).toHaveAccessibleDescription("رقم صحيح من ٠ إلى ٩٩٩٩.");
    await user.clear(order);
    await user.type(order, "٩");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));

    await waitFor(() => expect(view.sent(`PATCH /admin/categories/${MOCK_ADMIN.categories.first}`)).toHaveLength(1));
    expect(view.sent(`PATCH /admin/categories/${MOCK_ADMIN.categories.first}`)[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP, displayOrder: 9 });
    expect(await screen.findByText("تم حفظ التعديل")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["تصنيف تجريبي ثانٍ", "تصنيف تجريبي فارغ", "تصنيف تجريبي أول"]);
  });

  it("refuses an order that is not a whole number from 0 to 9999 without sending", async () => {
    const user = userEvent.setup();
    const view = renderList(<CategoriesScreen />);
    await user.click(within(await card("تصنيف تجريبي أول")).getByRole("button", { name: "تعديل تصنيف تجريبي أول" }));
    const dialog = await screen.findByRole("dialog");
    const order = within(dialog).getByRole("textbox", { name: "ترتيب العرض" });
    await user.clear(order);
    await user.type(order, "10000");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("أدخل رقمًا بين ٠ و٩٩٩٩.")).toBeInTheDocument();
    await user.clear(order);
    await user.type(order, "1.5");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("أدخل رقمًا صحيحًا.")).toBeInTheDocument();
    expect(view.sent(`PATCH /admin/categories/${MOCK_ADMIN.categories.first}`)).toHaveLength(0);
  });

  it("shows only the line for a content manager for an account that is not one (403)", async () => {
    renderList(<CategoriesScreen />, { scenario: { contentManager: false } });
    expect(await screen.findByText("هذه الصفحة لمدير المحتوى فقط.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });
});

describe("AD-06 Content sources", () => {
  it("lists the sources with the rights status, the links, the checked date and the edition count", async () => {
    renderList(<ContentSourcesScreen />);
    expect(await screen.findByRole("heading", { level: 1, name: "مصادر المحتوى" })).toBeInTheDocument();
    const first = await card("مصدر تجريبي أول");
    expect(within(first).getByText("حالة الحقوق:").nextElementSibling).toHaveTextContent("تم التحقق");
    expect(within(first).getByText("رابط المصدر:").nextElementSibling).toHaveTextContent("https://example.invalid/source-one");
    expect(within(first).getByText("رابط الترخيص (اختياري):").nextElementSibling).toHaveTextContent("https://example.invalid/license-one");
    expect(within(first).getByText("عدد الطبعات:").nextElementSibling).toHaveTextContent("٣");
    const second = await card("مصدر تجريبي ثانٍ");
    expect(within(second).getByText("حالة الحقوق:").nextElementSibling).toHaveTextContent("مقبول من المالك بانتظار التحقق");
    expect(within(second).getByText("رابط الترخيص (اختياري):").nextElementSibling).toHaveTextContent("لا يوجد");
    expect(within(second).getByText("تاريخ الفحص:").nextElementSibling).toHaveTextContent("غير متاح");
  });

  it("disables the delete of a source that an edition uses and allows it for an unused one", async () => {
    renderList(<ContentSourcesScreen />);
    const used = await card("مصدر تجريبي أول");
    expect(within(used).getByRole("button", { name: "حذف مصدر تجريبي أول" })).toHaveAttribute("aria-disabled", "true");
    expect(within(used).getByRole("button", { name: "حذف مصدر تجريبي أول" })).toHaveAccessibleDescription(IN_USE);
    const free = await card("مصدر تجريبي غير مستخدم");
    expect(within(free).getByRole("button", { name: "حذف مصدر تجريبي غير مستخدم" })).not.toHaveAttribute("aria-disabled");
  });

  it("deletes an unused source after the alert dialog confirms", async () => {
    const user = userEvent.setup();
    const view = renderList(<ContentSourcesScreen />);
    await user.click(within(await card("مصدر تجريبي غير مستخدم")).getByRole("button", { name: "حذف مصدر تجريبي غير مستخدم" }));
    const dialog = await screen.findByRole("alertdialog", { name: "حذف المصدر" });
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "حذف المصدر" }));
    await waitFor(() => expect(view.sent(`POST /admin/sources/${MOCK_ADMIN.sources.unused}/delete`)).toHaveLength(1));
    expect(await screen.findByText("تم الحذف")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("refuses a license link that does not start with https:// before sending, and then sends the link and the rights status that changed", async () => {
    const user = userEvent.setup();
    const view = renderList(<ContentSourcesScreen />);
    await user.click(within(await card("مصدر تجريبي ثانٍ")).getByRole("button", { name: "تعديل مصدر تجريبي ثانٍ" }));
    const dialog = await screen.findByRole("dialog", { name: "تعديل المصدر" });
    const license = within(dialog).getByRole("textbox", { name: "رابط الترخيص (اختياري)" });
    expect(license).toHaveValue("");

    await user.type(license, "http://example.invalid/license");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("يجب أن يبدأ الرابط بـ https://")).toBeInTheDocument();
    expect(view.sent(`PATCH /admin/sources/${MOCK_ADMIN.sources.second}`)).toHaveLength(0);

    await user.clear(license);
    await user.type(license, "https://example.invalid/license-two");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "حالة الحقوق" }), "verified");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));

    await waitFor(() => expect(view.sent(`PATCH /admin/sources/${MOCK_ADMIN.sources.second}`)).toHaveLength(1));
    expect(view.sent(`PATCH /admin/sources/${MOCK_ADMIN.sources.second}`)[0]?.body).toEqual({
      expectedUpdatedAt: SEED_STAMP,
      licenseUrl: "https://example.invalid/license-two",
      rightsStatus: "verified",
    });
    expect(await screen.findByText("تم حفظ التعديل")).toBeInTheDocument();
    const saved = await card("مصدر تجريبي ثانٍ");
    expect(within(saved).getByText("حالة الحقوق:").nextElementSibling).toHaveTextContent("تم التحقق");
  });

  it("sends null when the license link is cleared", async () => {
    const user = userEvent.setup();
    const view = renderList(<ContentSourcesScreen />);
    await user.click(within(await card("مصدر تجريبي أول")).getByRole("button", { name: "تعديل مصدر تجريبي أول" }));
    const dialog = await screen.findByRole("dialog");
    await user.clear(within(dialog).getByRole("textbox", { name: "رابط الترخيص (اختياري)" }));
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    await waitFor(() => expect(view.sent(`PATCH /admin/sources/${MOCK_ADMIN.sources.first}`)).toHaveLength(1));
    expect(view.sent(`PATCH /admin/sources/${MOCK_ADMIN.sources.first}`)[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP, licenseUrl: null });
    const saved = await card("مصدر تجريبي أول");
    expect(within(saved).getByText("رابط الترخيص (اختياري):").nextElementSibling).toHaveTextContent("لا يوجد");
  });

  it("offers the three rights statuses in the words of the deck", async () => {
    const user = userEvent.setup();
    renderList(<ContentSourcesScreen />);
    await user.click(within(await card("مصدر تجريبي أول")).getByRole("button", { name: "تعديل مصدر تجريبي أول" }));
    const dialog = await screen.findByRole("dialog");
    const options = within(within(dialog).getByRole("combobox", { name: "حالة الحقوق" })).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["مقبول من المالك بانتظار التحقق", "تم التحقق", "مرفوض"]);
  });

  it("shows only the line for a content manager for an account that is not one (403)", async () => {
    renderList(<ContentSourcesScreen />, { scenario: { contentManager: false } });
    expect(await screen.findByText("هذه الصفحة لمدير المحتوى فقط.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });
});
