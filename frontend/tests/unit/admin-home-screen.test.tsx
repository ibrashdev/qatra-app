import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useRouter: () => navigation.router }));
const browser = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock("@/lib/browser", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/browser")>()), ...browser }));

import { AdminHomeScreen } from "@/components/admin/AdminHomeScreen";
import { adminMockHandlers, MOCK_ADMIN } from "@/lib/api/mock/admin-handlers";
import { errorResponse, type MockHandler } from "@/lib/api/mock/handlers";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { cleanupAdmin, renderAdmin, type AdminRender } from "./admin-support";

let rendered: AdminRender | undefined;

function renderHome(options: Parameters<typeof renderAdmin>[1] = {}) {
  rendered = renderAdmin(<AdminHomeScreen />, options);
  return rendered;
}

beforeEach(() => {
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  browser.reloadPage.mockReset();
  clearLoginArrival();
});

afterEach(() => {
  cleanupAdmin(rendered);
  rendered = undefined;
});

const fail = (status: number, code: string, details: Record<string, unknown> = {}): MockHandler => () => errorResponse(status, code, "a message that is never shown", details);

describe("AD-01 Content management", () => {
  it("shows the H1, the display-only note, the three destinations with their counts, and the editions by status in Arabic", async () => {
    const view = renderHome();
    expect(await screen.findByRole("heading", { level: 1, name: "إدارة المحتوى" })).toBeInTheDocument();
    expect(await screen.findByText("التعديل هنا على بيانات العرض فقط. النص الأصلي لا يُعدَّل من هنا.")).toBeInTheDocument();
    expect(view.count("GET /admin/overview")).toBe(1);

    expect(screen.getByRole("link", { name: /^الكتب/ })).toHaveAttribute("href", "/admin/books");
    expect(screen.getByRole("link", { name: /^التصنيفات/ })).toHaveAttribute("href", "/admin/categories");
    expect(screen.getByRole("link", { name: /^مصادر المحتوى/ })).toHaveAttribute("href", "/admin/sources");
    expect(screen.getByRole("link", { name: /^الكتب/ })).toHaveTextContent("٣");

    const byStatus = screen.getByRole("heading", { level: 2, name: "الطبعات حسب الحالة" }).closest("section") as HTMLElement;
    expect(within(byStatus).getByText(/^مسودة/)).toHaveTextContent("مسودة: ٢");
    expect(within(byStatus).getByText(/^منشورة/)).toHaveTextContent("منشورة: ٢");
    expect(within(byStatus).getByText(/^مسحوبة/)).toHaveTextContent("مسحوبة: ١");
    expect(within(byStatus).getByText(/^تم فحصها/)).toHaveTextContent("تم فحصها: ١");
    expect(within(byStatus).getByText(/^مستبدلة/)).toHaveTextContent("مستبدلة: ١");
  });

  it("lists each edition with its book, label, version and status, linking to its details; a hidden one carries the mark", async () => {
    renderHome();
    const section = (await screen.findByRole("heading", { level: 2, name: "الطبعات" })).closest("section") as HTMLElement;
    const links = within(section).getAllByRole("link");
    expect(links).toHaveLength(7);
    const published = links.find((link) => link.getAttribute("href") === `/admin/editions/${MOCK_ADMIN.editions.published}`) as HTMLElement;
    expect(published).toHaveTextContent("كتاب تجريبي أول");
    expect(published).toHaveTextContent("طبعة تجريبية ٣");
    expect(published).toHaveTextContent("الإصدار ٣");
    expect(published).toHaveTextContent("منشورة");
    expect(published).not.toHaveTextContent("مخفية من الفهرس");

    const hidden = links.find((link) => link.getAttribute("href") === `/admin/editions/${MOCK_ADMIN.editions.hidden}`) as HTMLElement;
    expect(hidden).toHaveTextContent("منشورة");
    expect(hidden).toHaveTextContent("مخفية من الفهرس");
    const revoked = links.find((link) => link.getAttribute("href") === `/admin/editions/${MOCK_ADMIN.editions.revoked}`) as HTMLElement;
    expect(revoked).toHaveTextContent("مسحوبة");
  });

  it("shows the read-only AI card with its counters, and says it never writes content", async () => {
    renderHome();
    const card = (await screen.findByRole("heading", { level: 2, name: "حالة الذكاء الاصطناعي" })).closest("section") as HTMLElement;
    expect(within(card).getByText("للعرض فقط. الذكاء الاصطناعي لا يكتب المحتوى ولا يعدّله.")).toBeInTheDocument();
    expect(within(card).getByText("محادثة الخطة للمتعلمين").nextElementSibling).toHaveTextContent("مفعّلة");
    expect(within(card).getByText("مفتاح المزوّد").nextElementSibling).toHaveTextContent("مضبوط");
    expect(within(card).getByText("النماذج المجانية").nextElementSibling).toHaveTextContent("sample-free-model-a:free");
    expect(within(card).getByText("الحد اليومي للطلبات").nextElementSibling).toHaveTextContent("٢٠٠");
    expect(within(card).getByText("طلبات اليوم").nextElementSibling).toHaveTextContent("١٢");
    expect(within(card).getByText("طلبات آخر دقيقة").nextElementSibling).toHaveTextContent("١");
    // It is a card, not a form: nothing in it can be pressed.
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).queryByRole("link")).toBeNull();
    expect(within(card).queryByRole("textbox")).toBeNull();
  });

  it("says a counter is not available when the server cannot give it, and names a missing key and a switched-off conversation", async () => {
    const overview: MockHandler = () => ({
      status: 200,
      body: {
        counts: { categories: 0, books: 0, sources: 0, editions: { draft: 0, validated: 0, published: 0, superseded: 0, revoked: 0 } },
        editions: [],
        ai: { chatModelForLearners: false, providerConfigured: false, models: [], dailyCap: 0, usedToday: null, usedLastMinute: null },
      },
    });
    renderHome({ handlers: { "GET /admin/overview": overview } });
    const card = (await screen.findByRole("heading", { level: 2, name: "حالة الذكاء الاصطناعي" })).closest("section") as HTMLElement;
    expect(within(card).getByText("محادثة الخطة للمتعلمين").nextElementSibling).toHaveTextContent("معطّلة");
    expect(within(card).getByText("مفتاح المزوّد").nextElementSibling).toHaveTextContent("غير مضبوط");
    expect(within(card).getByText("النماذج المجانية").nextElementSibling).toHaveTextContent("لا توجد نماذج");
    expect(within(card).getByText("طلبات اليوم").nextElementSibling).toHaveTextContent("غير متاح");
    expect(within(card).getByText("طلبات آخر دقيقة").nextElementSibling).toHaveTextContent("غير متاح");
    expect(screen.getByText("لا توجد طبعات.")).toBeInTheDocument();
  });

  it("is written in English with the English book titles when the interface is English", async () => {
    renderHome({ language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Content management" })).toBeInTheDocument();
    expect(await screen.findByText("Edits here change display data only. The original text is never edited from here.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Books/ })).toHaveAttribute("href", "/admin/books");
    const published = screen.getAllByRole("link").find((link) => link.getAttribute("href") === `/admin/editions/${MOCK_ADMIN.editions.published}`) as HTMLElement;
    expect(published).toHaveTextContent("Sample book one");
    expect(published).toHaveTextContent("Version 3");
    expect(published).toHaveTextContent("Published");
  });
});

describe("AD-01: who may see it and what a failure does", () => {
  it("shows only the line for a content manager, and no data, for a signed-in account that is not one (403)", async () => {
    renderHome({ scenario: { contentManager: false } });
    expect(await screen.findByText("هذه الصفحة لمدير المحتوى فقط.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "إدارة المحتوى" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "العودة إلى الإعدادات" })).toHaveAttribute("href", "/settings");
    expect(screen.queryByRole("link", { name: /^الكتب/ })).toBeNull();
    expect(screen.queryByText("حالة الذكاء الاصطناعي")).toBeNull();
    expect(screen.queryByText("التعديل هنا على بيانات العرض فقط. النص الأصلي لا يُعدَّل من هنا.")).toBeNull();
  });

  it("returns to sign-in with the page as `next` when the session has ended (401)", async () => {
    renderHome({ scenario: { signedIn: false } });
    await vi.waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fadmin"));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("offers a retry for an outage, reads again on it, and never shows the server's message", async () => {
    let healthy = false;
    const real = adminMockHandlers["GET /admin/overview"] as MockHandler;
    const view = renderHome({ handlers: { "GET /admin/overview": (request, scenario) => (healthy ? real(request, scenario) : fail(503, "unavailable")(request, scenario)) } });
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.queryByText("a message that is never shown")).toBeNull();
    expect(view.count("GET /admin/overview")).toBe(1);

    healthy = true;
    await userEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    expect(await screen.findByRole("link", { name: /^الكتب/ })).toBeInTheDocument();
    expect(view.count("GET /admin/overview")).toBe(2);
    expect(screen.queryByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeNull();
  });

  it("says a generic error for an unexpected answer", async () => {
    renderHome({ handlers: { "GET /admin/overview": fail(500, "internal") } });
    expect(await screen.findByRole("alert")).toHaveTextContent("حدث خطأ غير متوقع. حاول مرة أخرى.");
  });
});
