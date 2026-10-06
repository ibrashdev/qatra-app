import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/sections/x", useRouter: () => navigation.router }));

import { SectionScreen } from "@/components/admin/SectionScreen";
import { MOCK_ADMIN } from "@/lib/api/mock/admin-handlers";
import { clearLoginArrival } from "@/lib/auth/flash";
import { cleanupAdmin, renderAdmin, type AdminRender } from "./admin-support";
import { installDialogPolyfill } from "./dialog-polyfill";

const S = MOCK_ADMIN.sections;

let rendered: AdminRender | undefined;

function renderSection(id: string, options: Parameters<typeof renderAdmin>[1] = {}) {
  rendered = renderAdmin(<SectionScreen id={id} />, options);
  return rendered;
}

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

describe("AD-03 Section", () => {
  it("shows the titles with their rename, the question counts by game type, and the units' text read only, with the note", async () => {
    renderSection(S.published);
    expect(await screen.findByRole("heading", { level: 1, name: "تفاصيل القسم" })).toBeInTheDocument();

    const titles = (await screen.findByRole("heading", { level: 2, name: "العنوان" })).closest("section") as HTMLElement;
    expect(within(titles).getByText("العنوان بالعربية").nextElementSibling).toHaveTextContent("القسم التجريبي الأول");
    expect(within(titles).getByText("العنوان بالإنجليزية").nextElementSibling).toHaveTextContent("Sample section one");
    expect(within(titles).getByRole("button", { name: "تغيير اسم القسم التجريبي الأول" })).toBeInTheDocument();

    const questions = screen.getByRole("heading", { level: 2, name: "الأسئلة حسب اللعبة" }).closest("section") as HTMLElement;
    expect(within(questions).getByText("ترتيب الكلمات").nextElementSibling).toHaveTextContent("٤");
    expect(within(questions).getByText("اختيار كلمة أو جزء").nextElementSibling).toHaveTextContent("٦");
    expect(within(questions).getByText("استرجاع كلمة").nextElementSibling).toHaveTextContent("٣");
    expect(within(questions).getByText("تمييز المتشابه").nextElementSibling).toHaveTextContent("٢");

    const units = screen.getByRole("heading", { level: 2, name: "النص الأصلي" }).closest("section") as HTMLElement;
    expect(within(units).getByText("النص معروض كما في المصدر ولا يمكن تعديله.")).toBeInTheDocument();
    const texts = within(units).getAllByText(/^نص تجريبي للوحدة/);
    expect(texts.map((text) => text.textContent)).toEqual(["نص تجريبي للوحدة الأولى", "نص تجريبي للوحدة الثانية", "نص تجريبي للوحدة الثالثة"]);
    // The text is read only: no field holds it, and it is right to left and Arabic whatever the interface language is.
    expect(within(units).queryByRole("textbox")).toBeNull();
    expect(within(units).queryByRole("button")).toBeNull();
    for (const text of texts) {
      expect(text).toHaveAttribute("dir", "rtl");
      expect(text).toHaveAttribute("lang", "ar");
    }
  });

  it("sets an ayah in the Quran face and a hadith unit in the hadith face", async () => {
    renderSection(S.published);
    const quran = await screen.findAllByText(/^نص تجريبي للوحدة/);
    for (const text of quran) {
      expect(text.className).toContain("font-quran");
      expect(text.className).toContain("text-quran");
      expect(text.className).not.toContain("font-hadith");
    }
    rendered?.unmount();
    cleanupAdmin(rendered);

    renderSection(S.hidden);
    const hadith = await screen.findAllByText(/^نص تجريبي للوحدة/);
    for (const text of hadith) {
      expect(text.className).toContain("font-hadith");
      expect(text.className).toContain("text-hadith");
      expect(text.className).not.toContain("font-quran");
    }
  });

  it("goes back to the edition the section belongs to once it is read", async () => {
    renderSection(S.published);
    await screen.findByRole("heading", { level: 2, name: "الأسئلة حسب اللعبة" });
    expect(screen.getByRole("link", { name: "رجوع إلى تفاصيل الطبعة" })).toHaveAttribute("href", `/admin/editions/${MOCK_ADMIN.editions.published}`);
  });

  it("renames the titles with only the changed field, no token, and a toast", async () => {
    const user = userEvent.setup();
    const view = renderSection(S.published);
    await user.click(await screen.findByRole("button", { name: "تغيير اسم القسم التجريبي الأول" }));
    const dialog = await screen.findByRole("dialog", { name: "تغيير اسم القسم" });
    const arabic = within(dialog).getByRole("textbox", { name: "العنوان بالعربية" });
    expect(arabic).toHaveFocus();
    await user.clear(arabic);
    await user.type(arabic, "عنوان تجريبي جديد");
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));

    await waitFor(() => expect(view.sent(`PATCH /admin/sections/${S.published}`)).toHaveLength(1));
    expect(view.sent(`PATCH /admin/sections/${S.published}`)[0]?.body).toEqual({ titleAr: "عنوان تجريبي جديد" });
    expect(await screen.findByText("تم حفظ التعديل")).toBeInTheDocument();
    const titles = screen.getByRole("heading", { level: 2, name: "العنوان" }).closest("section") as HTMLElement;
    expect(within(titles).getByText("العنوان بالعربية").nextElementSibling).toHaveTextContent("عنوان تجريبي جديد");
  });

  it("requires both titles in the rename dialog: the English one cannot be cleared", async () => {
    const user = userEvent.setup();
    const view = renderSection(S.published);
    await user.click(await screen.findByRole("button", { name: "تغيير اسم القسم التجريبي الأول" }));
    const dialog = await screen.findByRole("dialog", { name: "تغيير اسم القسم" });
    const english = within(dialog).getByRole("textbox", { name: "العنوان بالإنجليزية" });
    expect(english).toHaveValue("Sample section one");
    await user.clear(english);
    await user.click(within(dialog).getByRole("button", { name: "حفظ" }));
    expect(await within(dialog).findByText("هذا الحقل مطلوب.")).toBeInTheDocument();
    expect(view.sent(`PATCH /admin/sections/${S.published}`)).toHaveLength(0);
  });

  it("does not offer the rename for a section of a withdrawn edition, and says why", async () => {
    renderSection(S.revoked);
    expect(await screen.findByText("لا يمكن تغيير الاسم لأن الطبعة مسحوبة.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^تغيير اسم/ })).toBeNull();
  });

  it("shows an English interface with the English labels", async () => {
    renderSection(S.published, { language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Section details" })).toBeInTheDocument();
    expect(await screen.findByText("The text is shown as in the source and cannot be edited.")).toBeInTheDocument();
    expect(screen.getByText("Word order")).toBeInTheDocument();
  });

  it("shows only the line for a content manager for an account that is not one (403)", async () => {
    renderSection(S.published, { scenario: { contentManager: false } });
    expect(await screen.findByText("هذه الصفحة لمدير المحتوى فقط.")).toBeInTheDocument();
    expect(screen.queryByText(/^نص تجريبي للوحدة/)).toBeNull();
  });

  it("says the section no longer exists for an unknown id", async () => {
    renderSection("00000000-0000-4000-8000-00000000dead");
    expect(await screen.findByText("لم يعد هذا العنصر موجودًا.")).toBeInTheDocument();
  });
});
