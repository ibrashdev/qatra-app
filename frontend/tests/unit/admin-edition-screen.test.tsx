import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/editions/x", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/browser")>()), ...browser }));

import { EditionScreen } from "@/components/admin/EditionScreen";
import { adminMockHandlers, MOCK_ADMIN } from "@/lib/api/mock/admin-handlers";
import { errorResponse, type MockHandler } from "@/lib/api/mock/handlers";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { cleanupAdmin, renderAdmin, type AdminRender } from "./admin-support";
import { installDialogPolyfill } from "./dialog-polyfill";

const E = MOCK_ADMIN.editions;
const SEED_STAMP = "2026-10-05T08:00:00.000Z";
const NEVER_SHOWN = "a message that is never shown";

let rendered: AdminRender | undefined;

function renderEdition(id: string, options: Parameters<typeof renderAdmin>[1] = {}) {
  rendered = renderAdmin(<EditionScreen id={id} />, options);
  return rendered;
}

const conflict = (reason: string): MockHandler => () => errorResponse(409, "version_conflict", NEVER_SHOWN, { reason });
const patchPath = (id: string) => `PATCH /admin/editions/${id}`;

beforeEach(() => {
  installDialogPolyfill();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  clearLoginArrival();
});

afterEach(() => {
  cleanupAdmin(rendered);
  rendered = undefined;
});

describe("AD-02 Edition: what it shows", () => {
  it("shows the details, the counts, the sections with a link to their page and the job history of a published edition", async () => {
    renderEdition(E.published);
    expect(await screen.findByRole("heading", { level: 1, name: "تفاصيل الطبعة" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "كتاب تجريبي أول" })).toBeInTheDocument();

    const details = screen.getByRole("heading", { level: 2, name: "البيانات الأساسية" }).closest("section") as HTMLElement;
    expect(within(details).getByText("معرّف الطبعة").nextElementSibling).toHaveTextContent("sample-book-one-v3");
    expect(within(details).getByText("الحالة").nextElementSibling).toHaveTextContent("منشورة");
    expect(within(details).getByText("الإصدار").nextElementSibling).toHaveTextContent("٣");
    expect(within(details).getByText("إصدار بنك الأسئلة").nextElementSibling).toHaveTextContent("٢");
    expect(within(details).getByText("الظهور في الفهرس").nextElementSibling).toHaveTextContent("ظاهرة");
    expect(within(details).getByText("المصدر").nextElementSibling).toHaveTextContent("مصدر تجريبي أول");
    expect(within(details).getByText("حالة الحقوق").nextElementSibling).toHaveTextContent("تم التحقق");
    expect(within(details).getByText("بصمة المحتوى").nextElementSibling?.querySelector("bdi")).toHaveAttribute("dir", "ltr");
    expect(within(details).getByText("آخر تحديث").nextElementSibling).toHaveTextContent("٢٠٢٦");

    const approval = screen.getByRole("heading", { level: 2, name: "سجل الاعتماد" }).closest("section") as HTMLElement;
    // The approval words are the owner's text, in an isolate that follows its own direction.
    const words = within(approval).getByText("كلمات الاعتماد").nextElementSibling as HTMLElement;
    expect(words).toHaveTextContent("عبارة اعتماد تجريبية من المالك");
    expect(words.querySelector("bdi")).toHaveAttribute("dir", "auto");
    expect(within(approval).getByText("اعتمدها").nextElementSibling).toHaveTextContent("owner");
    expect(within(approval).getByText("تاريخ الاعتماد").nextElementSibling).toHaveTextContent("٢٠٢٦");
    expect(within(approval).getByText("النطاق").nextElementSibling).toHaveTextContent("whole edition");
    expect(within(approval).getByText("المصدر المعتمد").nextElementSibling).toHaveTextContent("sample-source");
    expect(screen.queryByRole("heading", { level: 2, name: "سجل السحب" })).toBeNull();

    const counts = screen.getByRole("heading", { level: 2, name: "محتوى الطبعة" }).closest("section") as HTMLElement;
    expect(within(counts).getByText("الأقسام").nextElementSibling).toHaveTextContent("٢");
    expect(within(counts).getByText("الوحدات").nextElementSibling).toHaveTextContent("٦");
    expect(within(counts).getByText("الأسئلة").nextElementSibling).toHaveTextContent("٣٠");

    const sections = screen.getByRole("heading", { level: 2, name: "الأقسام" }).closest("section") as HTMLElement;
    expect(within(sections).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["القسم التجريبي الأول", "القسم التجريبي الثاني"]);
    expect(within(sections).getByRole("link", { name: "عرض القسم التجريبي الأول" })).toHaveAttribute("href", `/admin/sections/${MOCK_ADMIN.sections.published}`);

    const jobs = screen.getByRole("heading", { level: 2, name: "سجل المراحل" }).closest("section") as HTMLElement;
    expect(within(jobs).getAllByRole("listitem").map((item) => item.textContent)).toEqual([expect.stringContaining("validated"), expect.stringContaining("published")]);

    // The text on offer is the actions the server allowed for a published edition, and not the one for a draft.
    for (const name of ["تغيير تسمية الطبعة", "إخفاء من الفهرس", "سحب الطبعة"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إظهار في الفهرس" })).toBeNull();
    expect(screen.queryByRole("button", { name: "حذف المسودة" })).toBeNull();
    expect(screen.getByText("الإخفاء من الفهرس يمكن التراجع عنه، أما سحب الطبعة فنهائي.")).toBeInTheDocument();
  });

  it("shows the withdrawal record of a withdrawn edition and offers no action and no section rename", async () => {
    renderEdition(E.revoked);
    const record = (await screen.findByRole("heading", { level: 2, name: "سجل السحب" })).closest("section") as HTMLElement;
    expect(within(record).getByText("السبب").nextElementSibling).toHaveTextContent("حقوق النشر");
    expect(within(record).getByText("الملاحظة").nextElementSibling).toHaveTextContent("ملاحظة تجريبية عن سبب السحب");
    expect(screen.getAllByText("مسحوبة").length).toBeGreaterThan(0);

    for (const name of ["تغيير تسمية الطبعة", "إخفاء من الفهرس", "إظهار في الفهرس", "سحب الطبعة", "حذف المسودة"]) expect(screen.queryByRole("button", { name }), name).toBeNull();
    expect(screen.getByText("لا توجد إجراءات متاحة في حالة الطبعة الحالية.")).toBeInTheDocument();
    expect(screen.getByText("لا يمكن تغيير الاسم لأن الطبعة مسحوبة.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^تغيير اسم/ })).toBeNull();
  });

  it("shows only the approval rows that have a value: an edition approved without words or source has neither row", async () => {
    renderEdition(E.superseded);
    const approval = (await screen.findByRole("heading", { level: 2, name: "سجل الاعتماد" })).closest("section") as HTMLElement;
    expect(within(approval).getByText("اعتمدها")).toBeInTheDocument();
    expect(within(approval).getByText("تاريخ الاعتماد")).toBeInTheDocument();
    expect(within(approval).getByText("النطاق")).toBeInTheDocument();
    expect(within(approval).queryByText("كلمات الاعتماد")).toBeNull();
    expect(within(approval).queryByText("المصدر المعتمد")).toBeNull();
  });

  it("leaves out the approval record when every field is null, and shows an unknown withdrawal reason as it is with no empty rows", async () => {
    const real = adminMockHandlers["GET /admin/editions/:id"] as MockHandler;
    const records: MockHandler = (request, scenario) => {
      const answer = real(request, scenario);
      return {
        status: answer.status,
        body: {
          ...(answer.body as object),
          approval: { who: null, at: null, scope: null, words: null, source: null },
          withdrawal: { reason: "a_reason_this_build_does_not_know", note: null, at: null },
        },
      };
    };
    renderEdition(E.revoked, { handlers: { "GET /admin/editions/:id": records } });
    const record = (await screen.findByRole("heading", { level: 2, name: "سجل السحب" })).closest("section") as HTMLElement;
    expect(within(record).getByText("السبب").nextElementSibling).toHaveTextContent("a_reason_this_build_does_not_know");
    expect(within(record).queryByText("الملاحظة")).toBeNull();
    expect(within(record).queryByText("تاريخ السحب")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "سجل الاعتماد" })).toBeNull();
  });

  it("leaves out the withdrawal record when none of its fields has a value", async () => {
    const real = adminMockHandlers["GET /admin/editions/:id"] as MockHandler;
    const empty: MockHandler = (request, scenario) => {
      const answer = real(request, scenario);
      return { status: answer.status, body: { ...(answer.body as object), withdrawal: { reason: null, note: null, at: null } } };
    };
    renderEdition(E.revoked, { handlers: { "GET /admin/editions/:id": empty } });
    expect(await screen.findByRole("heading", { level: 2, name: "سجل الاعتماد" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "سجل السحب" })).toBeNull();
  });

  it("shows the hidden mark and the way to show the edition again for a published edition that is hidden", async () => {
    renderEdition(E.hidden);
    expect(await screen.findByRole("button", { name: "إظهار في الفهرس" })).toBeInTheDocument();
    expect(screen.getAllByText("مخفية من الفهرس").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "إخفاء من الفهرس" })).toBeNull();
  });

  it("is written in English, with the English book title", async () => {
    renderEdition(E.published, { language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Edition details" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "Sample book one" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw the edition" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide from the catalog" })).toBeInTheDocument();
  });
});

describe("AD-02 Edition: rename", () => {
  it("opens a dialog on the label, sends only the changed field with the token it read, and confirms with a toast", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "تغيير تسمية الطبعة" }));

    const dialog = await screen.findByRole("dialog", { name: "تغيير تسمية الطبعة" });
    const field = within(dialog).getByRole("textbox", { name: "تسمية الطبعة" });
    expect(field).toHaveValue("طبعة تجريبية ٣");
    expect(field).toHaveFocus();

    await user.clear(field);
    await user.type(field, "  طبعة جديدة  ");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));

    await waitFor(() => expect(view.sent(patchPath(E.published))).toHaveLength(1));
    expect(view.sent(patchPath(E.published))[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP, editionLabel: "طبعة جديدة" });
    expect(await screen.findByText("تم حفظ التعديل")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    const details = screen.getByRole("heading", { level: 2, name: "البيانات الأساسية" }).closest("section") as HTMLElement;
    expect(within(details).getByText("تسمية الطبعة").nextElementSibling).toHaveTextContent("طبعة جديدة");
  });

  it("sends nothing and says so when nothing changed, and judges an empty label before sending", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "تغيير تسمية الطبعة" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("لا توجد تغييرات للحفظ.")).toBeInTheDocument();

    const field = within(dialog).getByRole("textbox", { name: "تسمية الطبعة" });
    await user.clear(field);
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("هذا الحقل مطلوب.")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
    expect(view.sent(patchPath(E.published))).toHaveLength(0);
  });

  it("shows the stale line with a reload button inside the dialog, and reads the edition again on it", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published, { handlers: { [patchPath(E.published)]: conflict("stale") } });
    await user.click(await screen.findByRole("button", { name: "تغيير تسمية الطبعة" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByRole("textbox", { name: "تسمية الطبعة" });
    await user.type(field, " ٢");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));

    expect(await within(dialog).findByText("تغيّرت البيانات منذ فتح الصفحة. أعد التحميل ثم حاول مرة أخرى.")).toBeInTheDocument();
    expect(screen.queryByText(NEVER_SHOWN)).toBeNull();
    expect(view.count(`GET /admin/editions/${E.published}`)).toBe(1);

    await user.click(within(dialog).getByRole("button", { name: "إعادة التحميل" }));
    await waitFor(() => expect(view.count(`GET /admin/editions/${E.published}`)).toBe(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("heading", { level: 2, name: "كتاب تجريبي أول" })).toBeInTheDocument();
  });

  it("says a generic failure without the server's text", async () => {
    const user = userEvent.setup();
    renderEdition(E.published, { handlers: { [patchPath(E.published)]: () => errorResponse(500, "internal", NEVER_SHOWN) } });
    await user.click(await screen.findByRole("button", { name: "تغيير تسمية الطبعة" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "تسمية الطبعة" }), "x");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("حدث خطأ غير متوقع. حاول مرة أخرى.")).toBeInTheDocument();
    expect(screen.queryByText(NEVER_SHOWN)).toBeNull();
  });

  it("closes on Cancel without sending anything", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    const opener = await screen.findByRole("button", { name: "تغيير تسمية الطبعة" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "إلغاء" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.sent(patchPath(E.published))).toHaveLength(0);
    expect(opener).toHaveFocus();
  });
});

describe("AD-02 Edition: hide and show", () => {
  it("hides a published edition at once, marks it, and offers to show it again", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "إخفاء من الفهرس" }));

    await waitFor(() => expect(view.sent(`POST /admin/editions/${E.published}/archive`)).toHaveLength(1));
    expect(view.sent(`POST /admin/editions/${E.published}/archive`)[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP });
    expect(await screen.findByText("أُخفيت الطبعة من الفهرس")).toBeInTheDocument();
    expect(screen.getAllByText("مخفية من الفهرس").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "إظهار في الفهرس" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إخفاء من الفهرس" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "إظهار في الفهرس" }));
    await waitFor(() => expect(view.sent(`POST /admin/editions/${E.published}/unarchive`)).toHaveLength(1));
    expect(await screen.findByText("أُظهرت الطبعة في الفهرس")).toBeInTheDocument();
    expect(screen.queryByText("مخفية من الفهرس")).toBeNull();
  });

  it("says the action is not available when the server answers 409 state, with a way to reload", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published, { handlers: { [`POST /admin/editions/${E.published}/archive`]: conflict("state") } });
    await user.click(await screen.findByRole("button", { name: "إخفاء من الفهرس" }));
    expect(await screen.findByText("هذا الإجراء غير متاح في حالة الطبعة الحالية.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "إعادة التحميل" }));
    await waitFor(() => expect(view.count(`GET /admin/editions/${E.published}`)).toBe(2));
  });
});

describe("AD-02 Edition: withdraw", () => {
  it("is an alert dialog that says it cannot be undone, puts the focus on Cancel, and asks for a reason and a note before sending", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "سحب الطبعة" }));

    const dialog = await screen.findByRole("alertdialog", { name: "سحب الطبعة" });
    expect(within(dialog).getByText("سحب الطبعة نهائي ولا يمكن التراجع عنه. ستتوقف عن الظهور للمتعلمين.")).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription("سحب الطبعة نهائي ولا يمكن التراجع عنه. ستتوقف عن الظهور للمتعلمين.");
    // The safe choice is the primary button and holds the focus.
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    expect(within(dialog).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(["خلل في النقل", "حقوق النشر", "الاعتماد العلمي"]);

    await user.click(within(dialog).getByRole("button", { name: "سحب الطبعة نهائيًا" }));
    expect(await within(dialog).findByText("اختر سبب السحب.")).toBeInTheDocument();
    expect(within(dialog).getByText("هذا الحقل مطلوب.")).toBeInTheDocument();
    expect(view.sent(`POST /admin/editions/${E.published}/withdraw`)).toHaveLength(0);
  });

  it("sends the reason and the trimmed note once, shows the withdrawal at once, and takes the withdraw button away", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "سحب الطبعة" }));
    const dialog = await screen.findByRole("alertdialog");

    await user.click(within(dialog).getByRole("radio", { name: "حقوق النشر" }));
    await user.type(within(dialog).getByRole("textbox", { name: "ملاحظة السحب" }), "  سبب تجريبي للسحب  ");
    expect(within(dialog).getByText("١٦/٥٠٠")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "سحب الطبعة نهائيًا" }));

    await waitFor(() => expect(view.sent(`POST /admin/editions/${E.published}/withdraw`)).toHaveLength(1));
    expect(view.sent(`POST /admin/editions/${E.published}/withdraw`)[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP, reason: "rights", note: "سبب تجريبي للسحب" });
    expect(await screen.findByText("سُحبت الطبعة")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByText("مسحوبة").length).toBeGreaterThan(0);
    const record = screen.getByRole("heading", { level: 2, name: "سجل السحب" }).closest("section") as HTMLElement;
    expect(within(record).getByText("الملاحظة").nextElementSibling).toHaveTextContent("سبب تجريبي للسحب");
    expect(screen.queryByRole("button", { name: "سحب الطبعة" })).toBeNull();
    // The button that opened the dialog is gone, so the focus goes to the page heading.
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "تفاصيل الطبعة" })).toHaveFocus());
  });

  it("does not send a note longer than 500 characters", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "سحب الطبعة" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("radio", { name: "خلل في النقل" }));
    const note = within(dialog).getByRole("textbox", { name: "ملاحظة السحب" });
    await user.click(note);
    await user.paste("ا".repeat(501));
    expect(within(dialog).getByText("٥٠١/٥٠٠")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "سحب الطبعة نهائيًا" }));
    expect(await within(dialog).findByText("النص أطول من الحد المسموح (٥٠٠ حرفًا).")).toBeInTheDocument();
    expect(view.sent(`POST /admin/editions/${E.published}/withdraw`)).toHaveLength(0);
  });

  it("does not send the form when Enter is pressed on a reason", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "سحب الطبعة" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox", { name: "ملاحظة السحب" }), "x");
    const radio = within(dialog).getByRole("radio", { name: "حقوق النشر" });
    await user.click(radio);
    radio.focus();
    await user.keyboard("{Enter}");
    expect(view.sent(`POST /admin/editions/${E.published}/withdraw`)).toHaveLength(0);
  });

  it("closes without sending when Cancel is pressed, and puts the focus back on the button that opened it", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    const opener = await screen.findByRole("button", { name: "سحب الطبعة" });
    await user.click(opener);
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "إلغاء" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(view.sent(`POST /admin/editions/${E.published}/withdraw`)).toHaveLength(0);
    expect(opener).toHaveFocus();
  });

  it("says so inside the dialog when the edition is no longer published (409 state)", async () => {
    const user = userEvent.setup();
    renderEdition(E.published, { handlers: { [`POST /admin/editions/${E.published}/withdraw`]: conflict("state") } });
    await user.click(await screen.findByRole("button", { name: "سحب الطبعة" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("radio", { name: "الاعتماد العلمي" }));
    await user.type(within(dialog).getByRole("textbox", { name: "ملاحظة السحب" }), "x");
    await user.click(within(dialog).getByRole("button", { name: "سحب الطبعة نهائيًا" }));
    expect(await within(dialog).findByText("هذا الإجراء غير متاح في حالة الطبعة الحالية.")).toBeInTheDocument();
  });
});

describe("AD-02 Edition: delete a draft", () => {
  it("asks first in an alert dialog whose Cancel holds the focus, and sends nothing on Cancel", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.draft);
    expect(screen.queryByRole("button", { name: "سحب الطبعة" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "حذف المسودة" }));

    const dialog = await screen.findByRole("alertdialog", { name: "حذف المسودة" });
    expect(dialog).toHaveTextContent("ستُحذف المسودة مسودة تجريبية ٢ وكل أقسامها ووحداتها نهائيًا. لا يمكن التراجع عن ذلك.");
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "إلغاء" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(view.sent(`POST /admin/editions/${E.draft}/delete`)).toHaveLength(0);
  });

  it("deletes once on confirm and shows that the draft is gone, with the way back", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.draft);
    await user.click(await screen.findByRole("button", { name: "حذف المسودة" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "حذف المسودة" }));

    await waitFor(() => expect(view.sent(`POST /admin/editions/${E.draft}/delete`)).toHaveLength(1));
    expect(view.sent(`POST /admin/editions/${E.draft}/delete`)[0]?.body).toEqual({ expectedUpdatedAt: SEED_STAMP });
    expect(await screen.findByRole("link", { name: "إدارة المحتوى" })).toHaveAttribute("href", "/admin");
    expect(screen.getAllByText("تم الحذف").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "حذف المسودة" })).toBeNull();
  });

  it("says why when a learner row still refers to the draft (409 in_use), and keeps the page", async () => {
    const user = userEvent.setup();
    renderEdition(E.draftInUse);
    await user.click(await screen.findByRole("button", { name: "حذف المسودة" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "حذف المسودة" }));
    expect(await screen.findByText("لا يمكن الحذف لأن عناصر أخرى تستخدم هذا العنصر.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "حذف المسودة" })).toBeInTheDocument();
  });
});

describe("AD-02 Edition: rename a section", () => {
  it("sends only the changed title, with no token, and shows the new title in the list", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "تغيير اسم القسم التجريبي الأول" }));

    const dialog = await screen.findByRole("dialog", { name: "تغيير اسم القسم" });
    const english = within(dialog).getByRole("textbox", { name: "العنوان بالإنجليزية" });
    expect(within(dialog).getByRole("textbox", { name: "العنوان بالعربية" })).toHaveValue("القسم التجريبي الأول");
    expect(english).toHaveValue("Sample section one");
    await user.clear(english);
    await user.type(english, "First sample section");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));

    await waitFor(() => expect(view.sent(`PATCH /admin/sections/${MOCK_ADMIN.sections.published}`)).toHaveLength(1));
    expect(view.sent(`PATCH /admin/sections/${MOCK_ADMIN.sections.published}`)[0]?.body).toEqual({ titleEn: "First sample section" });
    expect(await screen.findByText("تم حفظ التعديل")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requires an English title: it cannot be cleared, and nothing is sent until it is there", async () => {
    const user = userEvent.setup();
    const view = renderEdition(E.published);
    await user.click(await screen.findByRole("button", { name: "تغيير اسم القسم التجريبي الأول" }));
    const dialog = await screen.findByRole("dialog");
    const english = within(dialog).getByRole("textbox", { name: "العنوان بالإنجليزية" });
    await user.clear(english);
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("هذا الحقل مطلوب.")).toBeInTheDocument();
    expect(english).toHaveAttribute("aria-invalid", "true");
    expect(english).toHaveFocus();
    expect(view.sent(`PATCH /admin/sections/${MOCK_ADMIN.sections.published}`)).toHaveLength(0);

    await user.type(english, "A new title");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    await waitFor(() => expect(view.sent(`PATCH /admin/sections/${MOCK_ADMIN.sections.published}`)).toHaveLength(1));
    expect(view.sent(`PATCH /admin/sections/${MOCK_ADMIN.sections.published}`)[0]?.body).toEqual({ titleEn: "A new title" });
  });
});

describe("AD-02 Edition: who may see it and what a failure does", () => {
  it("shows only the line for a content manager for an account that is not one (403)", async () => {
    renderEdition(E.published, { scenario: { contentManager: false } });
    expect(await screen.findByText("هذه الصفحة لمدير المحتوى فقط.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "سحب الطبعة" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "كتاب تجريبي أول" })).toBeNull();
  });

  it("returns to sign-in with this edition as `next` when the session ended (401)", async () => {
    renderEdition(E.published, { scenario: { signedIn: false } });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(`/admin/editions/${E.published}`)}`));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("says the edition no longer exists for an unknown id, with the way back to the list", async () => {
    renderEdition("00000000-0000-4000-8000-00000000dead");
    expect(await screen.findByText("لم يعد هذا العنصر موجودًا.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "العودة إلى القائمة" })).toHaveAttribute("href", "/admin");
  });
});
