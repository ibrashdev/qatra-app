import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/plan/chat/x", useRouter: () => navigation.router }));

import { peekPlanConfirmed, takePlanConfirmed } from "@/components/plan-chat/confirmed-flash";
import { PlanChatScreen } from "@/components/plan-chat/PlanChatScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { createMockFetch, MOCK_CHAT_GOALS, MOCK_CHAT_TEXTS, MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, MOCK_REFUSAL, type MockScenario } from "@/lib/api/mock";
import type { CreatePlanChatRequest, PlanChat } from "@/lib/api/types";
import { peekLoginArrival, clearLoginArrival } from "@/lib/auth/flash";
import { installDialogPolyfill } from "./dialog-polyfill";

const UUID = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;

type Real = () => Promise<Response>;
type Override = (real: Real, call: number) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const apiError = (status: number, code: string, details: Record<string, unknown> = {}) => jsonResponse({ error: { code, message: "m", details } }, status);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The mock layer answers by default; a test overrides single operations ("GET /api/plan-chats/:id"). Every call is recorded.
function makeBackend(overrides: Record<string, Override> = {}, scenario: Partial<MockScenario> = {}) {
  const mock = createMockFetch({ latencyMs: 0, scenario: { signedIn: true, hasPlan: true, ...scenario } });
  const calls: { key: string; body: unknown }[] = [];
  const seen = new Map<string, number>();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(UUID, ":id")}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const call = (seen.get(key) ?? 0) + 1;
    seen.set(key, call);
    const override = overrides[key];
    const real: Real = () => mock(input, init);
    return override ? override(real, call) : real();
  });
  return { fetchImpl, calls, count: (key: string) => calls.filter((entry) => entry.key === key).length, bodies: (key: string) => calls.filter((entry) => entry.key === key).map((entry) => entry.body) };
}
type Backend = ReturnType<typeof makeBackend>;

const request = (over: Partial<CreatePlanChatRequest> = {}): CreatePlanChatRequest => ({
  editionId: MOCK_QURAN_EDITION_ID,
  targetScope: { sectionOrdinals: [1, 2] },
  paths: ["quran"],
  sessionMinutes: 5,
  preferredDate: "2026-10-20",
  goalText: "Synthetic goal sentence",
  language: "ar",
  ...over,
});

let runtime: ApiRuntime;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

// Starts a conversation through the same mock session the screen reads, then renders the screen on it.
async function open({
  language = "ar",
  backend = makeBackend(),
  chat: over = {},
  chatId,
}: { language?: "ar" | "en"; backend?: Backend; chat?: Partial<CreatePlanChatRequest>; chatId?: string } = {}) {
  setLanguage(language);
  runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const created: PlanChat = await runtime.api.createPlanChat(request({ language, ...over }));
  backend.calls.length = 0;
  const id = chatId ?? created.chatId;
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <PlanChatScreen chatId={id} />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, created, id, ...view };
}

const MESSAGES_KEY = "POST /api/plan-chats/:id/messages";
const CONFIRM_KEY = "POST /api/plan-chats/:id/confirm";
const CHAT_KEY = "GET /api/plan-chats/:id";

const ready = () => screen.findByRole("log");
const confirmButton = () => screen.getByRole("button", { name: /^(اعتماد الخطة|جارٍ الاعتماد…|Confirm the plan|Confirming…)$/ });
const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: /^(إرسال|Send)$/ });
const chip = (name: string) => screen.getByRole("button", { name });
const group = (name = "اختصارات التعديل") => screen.getByRole("group", { name });

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  takePlanConfirmed();
  navigation.router.replace.mockReset();
  navigation.router.push.mockReset();
  installDialogPolyfill();
  document.documentElement.style.overflow = "";
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.restoreAllMocks();
});

describe("S-34 structure (UI-screens S-34 sections 2, 3 and 5)", () => {
  it("shows the heading, the back control, the log with the notice first, the card, the shortcuts, the dock", async () => {
    await open();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "مراجعة الخطة مع المساعد" })).toHaveAttribute("data-page-heading");
    expect(document.title).toBe("مراجعة الخطة مع المساعد · قطرة غيث");
    expect(screen.getByRole("link", { name: "رجوع إلى ما هي خطتك؟" })).toHaveAttribute("href", "/start");

    const log = screen.getByRole("log", { name: "المحادثة مع المساعد" });
    expect(log).toHaveAttribute("aria-relevant", "additions");
    expect(log.firstElementChild?.textContent).toContain("تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي");
    expect(within(log).getByText("هذه خطة مقترحة. راجع البطاقة أدناه أو اختر تعديلًا.")).toBeInTheDocument();
    expect(within(log).getByText("المساعد")).toBeInTheDocument();

    expect(screen.getByText("الاقتراح ١ · الحالي")).toBeInTheDocument();
    const terms = screen.getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["الهدف الكلي", "الزمن الكلي", "الزمن اليومي", "المراحل", "المراجعات", "الخطوة التالية"]);
    expect(screen.getAllByRole("definition")).toHaveLength(6);
  });

  it("orders the page: thread, shortcuts, then the dock with the confirm button above the composer", async () => {
    await open();
    await ready();
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByRole("log"), group())).toBe(true);
    expect(follows(group(), confirmButton())).toBe(true);
    expect(follows(confirmButton(), composer())).toBe(true);
    expect(composer()).toHaveAccessibleName("رسالتك إلى المساعد");
    expect(screen.getByText("لا تكتب اسمك أو أي بيانات شخصية.")).toBeInTheDocument();
    expect(screen.getByText("٠/٥٠٠")).toBeInTheDocument();
    expect(composer()).toHaveAttribute("dir", "auto");
    expect(composer()).toHaveAttribute("enterkeyhint", "send");
    expect(composer()).not.toHaveAttribute("maxlength");
  });

  it("moves focus to the heading once the conversation is read", async () => {
    await open();
    await ready();
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus());
  });

  it("describes the confirm button by the current card, and the card is a section of six labelled pairs", async () => {
    await open();
    await ready();
    expect(confirmButton()).toHaveAttribute("aria-describedby", expect.stringContaining("plan-chat-current-card"));
    expect(confirmButton()).not.toHaveAttribute("aria-disabled");
    const card = document.getElementById("plan-chat-current-card") as HTMLElement;
    expect(card.tagName).toBe("SECTION");
    expect(within(card).getAllByRole("term")).toHaveLength(6);
  });

  it("renders in English with the proposed counterparts", async () => {
    await open({ language: "en" });
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "Plan review with the assistant" })).toBeInTheDocument();
    expect(screen.getByText("Proposal 1 · Current")).toBeInTheDocument();
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(["Overall goal", "Overall time", "Daily time", "Stages", "Reviews", "Next step"]);
    expect(group("Edit shortcuts")).toBeInTheDocument();
    expect(confirmButton()).toHaveTextContent("Confirm the plan");
    expect(screen.getByText("0/500")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to What is your plan?" })).toBeInTheDocument();
  });

  it("never shows a model name or a cap number", async () => {
    const backend = makeBackend({
      [CHAT_KEY]: async (real) => {
        const chat = (await (await real()).json()) as PlanChat;
        return jsonResponse({ ...chat, modelTurnsLeft: 3, assistant: { source: "model", model: "vendor/free-model-x" } });
      },
    });
    await open({ backend });
    await ready();
    expect(screen.queryByText(/free-model-x/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/model/i);
  });
});

describe("quick replies (c12)", () => {
  it("renders the server's chips exactly, in the server order, as one group", async () => {
    await open();
    await ready();
    const labels = within(group()).getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["دقائق أكثر", "هدف أصغر", "موعد أبعد", "دون موعد محدد", "الترتيب العكسي للقرآن", "اعتماد"]);
  });

  it("is one tab stop with a roving tabindex: arrows follow the reading direction, Home and End jump", async () => {
    await open();
    await ready();
    const user = userEvent.setup();
    const buttons = within(group()).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1", "-1", "-1"]);
    buttons[0]?.focus();
    // Arabic: Left is next.
    await user.keyboard("{ArrowLeft}");
    expect(buttons[1]).toHaveFocus();
    expect(buttons.map((button) => button.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1", "-1", "-1"]);
    await user.keyboard("{ArrowRight}");
    expect(buttons[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(buttons[5]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(buttons[0]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(buttons[5]).toHaveFocus(); // wraps
  });

  it("follows the other direction in English", async () => {
    await open({ language: "en" });
    await ready();
    const user = userEvent.setup();
    const buttons = within(group("Edit shortcuts")).getAllByRole("button");
    buttons[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(buttons[1]).toHaveFocus();
  });

  it("sends E32 with the code, shows the learner's label at once and a status line while the assistant replies, then the new card", async () => {
    const gate = deferred<void>();
    const backend = makeBackend({ [MESSAGES_KEY]: async (real) => (await gate.promise, real()) });
    const { id } = await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.click(chip("دقائق أكثر"));

    const log = screen.getByRole("log");
    expect(within(log).getByText("دقائق أكثر")).toBeInTheDocument();
    expect(screen.getByText("يرد المساعد…")).toBeInTheDocument();
    expect(screen.getByText("يرد المساعد…").closest("[role=status]")).toHaveAttribute("aria-live", "polite");
    expect(chip("هدف أصغر")).toHaveAttribute("aria-disabled", "true");
    expect(confirmButton()).toHaveAttribute("aria-disabled", "true");
    expect(sendButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(chip("هدف أصغر"));
    expect(backend.count(MESSAGES_KEY)).toBe(1);

    gate.resolve();
    await screen.findByText("الاقتراح ٢ · الحالي");
    expect(backend.bodies(MESSAGES_KEY)).toEqual([{ quickReply: "more_minutes" }]);
    expect(screen.queryByText("يرد المساعد…")).not.toBeInTheDocument();
    expect(screen.getByText("اقتراح سابق (١)")).toBeInTheDocument();
    expect(confirmButton()).not.toHaveAttribute("aria-disabled");
    expect(id).toBeTruthy();
    // A chip moves focus to the new assistant message, named «رد المساعد».
    const replies = screen.getAllByRole("group", { name: "رد المساعد" });
    expect(replies[replies.length - 1]).toHaveFocus();
    // The chips refresh from the server: «دقائق أكثر» is gone at 10 minutes? No, 15 is still available, but «أقل دقائق» is new.
    expect(chip("أقل دقائق")).toBeInTheDocument();
  });

  it("collapses an earlier card with the chip «سابق» and no actions, and keeps only the current one described", async () => {
    await open();
    await ready();
    const user = userEvent.setup();
    await user.click(chip("دقائق أكثر"));
    await screen.findByText("الاقتراح ٢ · الحالي");
    const earlier = screen.getByText("اقتراح سابق (١)").closest("details") as HTMLDetailsElement;
    expect(earlier.open).toBe(false);
    expect(within(earlier).getByText("سابق")).toBeInTheDocument();
    expect(within(earlier).queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelectorAll("#plan-chat-current-card")).toHaveLength(1);
  });

  it("treats the confirm chip as the confirm action: E34, never E32", async () => {
    const backend = makeBackend({}, { hasPlan: false });
    await open({ backend });
    await ready();
    await userEvent.setup().click(chip("اعتماد"));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.count(MESSAGES_KEY)).toBe(0);
    expect(backend.bodies(CONFIRM_KEY)).toEqual([{ proposalVersion: 1 }]);
  });
});

describe("composer (c15 to c17)", () => {
  it("sends on Enter, trimmed, and keeps focus in the text area after the reply", async () => {
    const backend = makeBackend();
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), "  أريد خطة أقصر  {Enter}");
    // Free text the rules do not read: the fallback notice, shown once.
    await screen.findByText("المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.");
    expect(backend.bodies(MESSAGES_KEY)).toEqual([{ text: "أريد خطة أقصر" }]);
    expect(composer().value).toBe("");
    await waitFor(() => expect(composer()).toHaveFocus());
  });

  it("inserts a newline on Shift+Enter and does not send", async () => {
    const backend = makeBackend();
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), "first{Shift>}{Enter}{/Shift}second");
    expect(composer().value).toBe("first\nsecond");
    expect(backend.count(MESSAGES_KEY)).toBe(0);
  });

  it("does not send on Enter during IME composition", async () => {
    const backend = makeBackend();
    await open({ backend });
    await ready();
    fireEvent.change(composer(), { target: { value: "text" } });
    fireEvent.keyDown(composer(), { key: "Enter", isComposing: true });
    expect(backend.count(MESSAGES_KEY)).toBe(0);
    expect(composer().value).toBe("text");
  });

  it("counts code points, accepts exactly 500 and blocks 501 without cutting the text", async () => {
    const backend = makeBackend();
    await open({ backend });
    await ready();
    fireEvent.change(composer(), { target: { value: "\u{1F4A7}".repeat(500) } });
    expect(screen.getByText("٥٠٠/٥٠٠")).toBeInTheDocument();
    expect(sendButton()).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("الرسالة حتى ٥٠٠ حرف.")).not.toBeInTheDocument();

    fireEvent.change(composer(), { target: { value: "\u{1F4A7}".repeat(501) } });
    expect(screen.getByText("٥٠١/٥٠٠")).toBeInTheDocument();
    expect(screen.getByText("الرسالة حتى ٥٠٠ حرف.")).toBeInTheDocument();
    expect(sendButton()).toHaveAttribute("aria-disabled", "true");
    expect(composer()).toHaveAttribute("aria-invalid", "true");
    fireEvent.keyDown(composer(), { key: "Enter" });
    await userEvent.setup().click(sendButton());
    expect(backend.count(MESSAGES_KEY)).toBe(0);
    expect(Array.from(composer().value)).toHaveLength(501);

    fireEvent.change(composer(), { target: { value: "\u{1F4A7}".repeat(500) } });
    expect(screen.queryByText("الرسالة حتى ٥٠٠ حرف.")).not.toBeInTheDocument();
  });

  it("blocks an empty message, and keeps the text area editable while a reply is pending so a draft is not lost", async () => {
    const gate = deferred<void>();
    const backend = makeBackend({ [MESSAGES_KEY]: async (real) => (await gate.promise, real()) });
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    expect(sendButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(sendButton());
    expect(backend.count(MESSAGES_KEY)).toBe(0);

    await user.type(composer(), "one{Enter}");
    await screen.findByText("يرد المساعد…");
    await user.type(composer(), "a draft");
    expect(composer()).not.toHaveAttribute("readonly");
    await user.keyboard("{Enter}");
    expect(backend.count(MESSAGES_KEY)).toBe(1);
    expect(composer().value).toBe("a draft");
    gate.resolve();
    await waitFor(() => expect(screen.queryByText("يرد المساعد…")).not.toBeInTheDocument());
    expect(composer().value).toBe("a draft");
  });

  it("adds the one-reply-left note to the helper when one model reply remains", async () => {
    const backend = makeBackend({
      [CHAT_KEY]: async (real) => jsonResponse({ ...((await (await real()).json()) as PlanChat), modelTurnsLeft: 1 }),
    });
    await open({ backend });
    await ready();
    expect(screen.getByText(/بقي رد واحد للمساعد في هذه المحادثة\./)).toBeInTheDocument();
  });
});

describe("demo account (D29)", () => {
  it("disables the text area with the note, hides the counter and helper, and keeps the chips and the confirm button", async () => {
    const backend = makeBackend({}, { isDemo: true });
    await open({ backend });
    await ready();
    expect(composer()).toHaveAttribute("aria-disabled", "true");
    expect(composer()).toHaveAttribute("readonly");
    expect(screen.getByText("في حساب العرض تُعدَّل الخطة بالخيارات الجاهزة فقط.")).toBeInTheDocument();
    expect(composer()).toHaveAccessibleDescription("في حساب العرض تُعدَّل الخطة بالخيارات الجاهزة فقط.");
    expect(screen.queryByText("٠/٥٠٠")).not.toBeInTheDocument();
    expect(screen.queryByText("لا تكتب اسمك أو أي بيانات شخصية.")).not.toBeInTheDocument();
    expect(sendButton()).toHaveAttribute("aria-disabled", "true");

    const user = userEvent.setup();
    await user.type(composer(), "typed{Enter}");
    expect(composer().value).toBe("");
    expect(backend.count(MESSAGES_KEY)).toBe(0);
    expect(confirmButton()).not.toHaveAttribute("aria-disabled");
    await user.click(chip("دقائق أكثر"));
    await screen.findByText("الاقتراح ٢ · الحالي");
    expect(backend.bodies(MESSAGES_KEY)).toEqual([{ quickReply: "more_minutes" }]);
  });
});

describe("the assistant's fixed messages (c9 to c11)", () => {
  it("shows the D26 refusal as an assistant message with the info icon, and the proposal is unchanged", async () => {
    await open();
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), "what is the ruling{Enter}");
    const refusal = await screen.findByText(MOCK_REFUSAL.ar);
    expect(refusal.closest("p")?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("الاقتراح ١ · الحالي")).toBeInTheDocument();
    expect(screen.queryByText("الاقتراح ٢ · الحالي")).not.toBeInTheDocument();
  });

  it("shows the fallback notice once per conversation, and a later unread text gets an ordinary reply", async () => {
    await open();
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), "something unclear{Enter}");
    await screen.findByText("المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.");
    await user.type(composer(), "still unclear{Enter}");
    await screen.findByText("لم يتغير شيء. جرّب أحد الخيارات أدناه.");
    expect(screen.getAllByText("المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.")).toHaveLength(1);
    expect(confirmButton()).not.toHaveAttribute("aria-disabled");
  });

  it("offers «تعديل بالنموذج» to S-13 under the notice of a revision conversation only", async () => {
    await open({ chat: { planId: MOCK_PLAN_ID } });
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), "something unclear{Enter}");
    await screen.findByText("المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.");
    expect(screen.getByRole("link", { name: "تعديل بالنموذج" })).toHaveAttribute("href", "/plan/revise?form=1");
  });

  it("shows the cap banner when no model turns are left and the server answered with a fallback, never the number", async () => {
    const backend = makeBackend({
      [CHAT_KEY]: async (real) => {
        const chat = (await (await real()).json()) as PlanChat;
        const fallback = { ...chat.messages[0], messageId: "77777777-7777-4777-8777-0000000000aa", ordinal: 2, kind: "fallback", text: "Fallback text" };
        return jsonResponse({ ...chat, modelTurnsLeft: 0, messages: [...chat.messages, fallback] });
      },
    });
    await open({ backend });
    await ready();
    const banner = screen.getByText("بلغت حد ردود المساعد في هذه المحادثة؛ نتابع بالاختصارات.");
    expect(banner.textContent).not.toMatch(/[0-9٠-٩]/);
    expect(screen.getByText("Fallback text")).toBeInTheDocument();
    expect(composer()).not.toHaveAttribute("aria-disabled"); // rules replies and shortcuts continue
  });

  it("isolates an ISO date in an assistant text and in a card section, so it neither wraps at its hyphens nor mixes into the Arabic line", async () => {
    const sentence = "الخطة الحالية: 5 أيام بمعدل 15 دقيقة يوميًا، وتنتهي في 2026-10-11. يمكنك المتابعة بالخيارات أدناه.";
    const backend = makeBackend({
      [CHAT_KEY]: async (real) => {
        const chat = (await (await real()).json()) as PlanChat;
        const reply = { ...chat.messages[0], messageId: "77777777-7777-4777-8777-0000000000bb", ordinal: 2, kind: "text", text: sentence };
        const proposal = chat.proposal === null ? null : { ...chat.proposal, sections: { ...chat.proposal.sections, nextStep: "نبدأ في 2026-10-12 بإذن الله" } };
        return jsonResponse({ ...chat, proposal, messages: [...chat.messages, reply] });
      },
    });
    await open({ backend });
    await ready();

    const messageDate = screen.getByText("2026-10-11");
    expect(messageDate.tagName).toBe("BDI");
    expect(messageDate).toHaveAttribute("dir", "ltr");
    expect(messageDate).toHaveClass("whitespace-nowrap");
    expect(messageDate.closest("span")?.textContent).toBe(sentence);

    const cardDate = screen.getByText("2026-10-12");
    expect(cardDate.tagName).toBe("BDI");
    expect(cardDate).toHaveAttribute("dir", "ltr");
    expect(cardDate).toHaveClass("whitespace-nowrap");
    expect(cardDate.closest("dd")?.textContent).toBe("نبدأ في 2026-10-12 بإذن الله");
  });
});

describe("confirming (c14, P-12)", () => {
  it("saves a first plan without a dialog: E34 with the current version, then S-11 with the toast note", async () => {
    const backend = makeBackend({}, { hasPlan: false });
    await open({ backend });
    await ready();
    await userEvent.setup().click(confirmButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.bodies(CONFIRM_KEY)).toEqual([{ proposalVersion: 1 }]);
    expect(peekPlanConfirmed()).toBe("created");
    expect(confirmButton()).toHaveAttribute("aria-busy", "true");
    expect(confirmButton()).toHaveTextContent("جارٍ الاعتماد…");
  });

  it("sends the proposalVersion the learner sees after changes", async () => {
    const backend = makeBackend({}, { hasPlan: false });
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.click(chip("دقائق أكثر"));
    await screen.findByText("الاقتراح ٢ · الحالي");
    await user.click(confirmButton());
    await waitFor(() => expect(backend.bodies(CONFIRM_KEY)).toEqual([{ proposalVersion: 2 }]));
  });

  it("asks before it replaces an active plan: the safe action first and focused, Esc cancels, nothing is sent", async () => {
    const backend = makeBackend();
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.click(confirmButton());
    const dialog = await screen.findByRole("dialog", { name: "بدء خطة جديدة؟" });
    expect(dialog).toHaveTextContent("ستتوقف خطتك الحالية «عنوان الكتاب (عنصر نائب)» مؤقتًا ويبقى تقدمها محفوظًا");
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    fireEvent(dialog, new Event("cancel", { cancelable: true })); // Escape
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(backend.count(CONFIRM_KEY)).toBe(0);

    await user.click(confirmButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد الخطة الجديدة" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.count(CONFIRM_KEY)).toBe(1);
    expect(peekPlanConfirmed()).toBe("created");
  });

  it("asks before a revision is confirmed, and is disabled with its hint until the proposal differs from the plan", async () => {
    const backend = makeBackend();
    await open({ backend, chat: { planId: MOCK_PLAN_ID, sessionMinutes: 10 } });
    await ready();
    expect(confirmButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("لم يتغير شيء بعد؛ اطلب تعديلًا أو اختر اختصارًا.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "رجوع إلى تعديل الوقت والهدف" })).toHaveAttribute("href", "/plan/revise");
    const user = userEvent.setup();
    await user.click(confirmButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(backend.count(CONFIRM_KEY)).toBe(0);

    await user.click(chip("أقل دقائق"));
    await screen.findByText("الاقتراح ٢ · الحالي");
    expect(confirmButton()).not.toHaveAttribute("aria-disabled");
    await user.click(confirmButton());
    const dialog = await screen.findByRole("dialog", { name: "اعتماد التعديل؟" });
    expect(dialog).toHaveTextContent("يسري هذا التعديل من يوم التعلم التالي");
    await user.click(within(dialog).getByRole("button", { name: "اعتماد التعديل" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(peekPlanConfirmed()).toBe("revised");
  });

  it("is disabled with its hint when the conversation holds no proposal", async () => {
    const backend = makeBackend({
      [CHAT_KEY]: async (real) => jsonResponse({ ...((await (await real()).json()) as PlanChat), proposal: null }),
    });
    await open({ backend });
    await ready();
    expect(confirmButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("اطلب خطة أو اختر اختصارًا أولًا.")).toBeInTheDocument();
    await userEvent.setup().click(confirmButton());
    expect(backend.count(CONFIRM_KEY)).toBe(0);
  });

  it("answers a stale proposal with the warning, the new card and focus on its chip row; nothing is saved", async () => {
    const backend = makeBackend({}, { hasPlan: false });
    await open({ backend, chat: { goalText: MOCK_CHAT_GOALS.stale } });
    await ready();
    const user = userEvent.setup();
    await user.click(confirmButton());
    expect(await screen.findByText("تغيّرت الخطة المقترحة. راجع البطاقة الجديدة ثم أكّد.")).toBeInTheDocument();
    await screen.findByText("الاقتراح ٢ · الحالي");
    const row = document.querySelector("[data-current-card] [data-card-chip]") as HTMLElement;
    await waitFor(() => expect(row).toHaveFocus());
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect(confirmButton()).not.toHaveAttribute("aria-busy");

    await user.click(confirmButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.bodies(CONFIRM_KEY)).toEqual([{ proposalVersion: 1 }, { proposalVersion: 2 }]);
  });

  it("answers a revision whose plan moved with the warning and «ابدأ من جديد» to S-13", async () => {
    const backend = makeBackend();
    await open({ backend, chat: { planId: MOCK_PLAN_ID, sessionMinutes: 10, goalText: MOCK_CHAT_GOALS.planMoved } });
    await ready();
    const user = userEvent.setup();
    await user.click(chip("أقل دقائق"));
    await screen.findByText("الاقتراح ٢ · الحالي");
    await user.click(confirmButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد التعديل" }));
    expect(await screen.findByText("عُدّلت خطتك في مكان آخر. ابدأ التعديل من جديد على النسخة الحالية.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ابدأ من جديد" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/plan/revise");
    expect(navigation.router.replace).not.toHaveBeenCalledWith("/today");
  });

  it("answers an active-plan race with «تحديث», which reads E18 and E33 again and asks the dialog again", async () => {
    const backend = makeBackend();
    await open({ backend, chat: { goalText: MOCK_CHAT_GOALS.race } });
    await ready();
    const user = userEvent.setup();
    await user.click(confirmButton());
    await user.click(await screen.findByRole("button", { name: "اعتماد الخطة الجديدة" }));
    expect(await screen.findByText("بدأت خطة أخرى للتو. حدّث الصفحة ثم أعد المحاولة.")).toBeInTheDocument();
    backend.calls.length = 0;
    await user.click(screen.getByRole("button", { name: "تحديث" }));
    await screen.findByRole("dialog", { name: "بدء خطة جديدة؟" });
    expect(backend.count("GET /api/today")).toBe(1);
    expect(backend.count(CHAT_KEY)).toBe(1);
    expect(screen.queryByText("بدأت خطة أخرى للتو. حدّث الصفحة ثم أعد المحاولة.")).not.toBeInTheDocument();
  });

  it("answers an inactive plan with the warning and turns the dock read-only", async () => {
    const backend = makeBackend({}, { hasPlan: false });
    await open({ backend, chat: { goalText: MOCK_CHAT_GOALS.inactive } });
    await ready();
    await userEvent.setup().click(confirmButton());
    expect(await screen.findByText("هذه الخطة غير نشطة.")).toBeInTheDocument();
    expect(confirmButton()).toHaveAttribute("aria-disabled", "true");
    expect(sendButton()).toHaveAttribute("aria-disabled", "true");
    expect(chip("دقائق أكثر")).toHaveAttribute("aria-disabled", "true");
  });

  it("after a lost answer asks E33 first: a plan that was saved goes straight to S-11, nothing is sent twice (P-14)", async () => {
    let lost = true;
    const backend = makeBackend(
      {
        [CONFIRM_KEY]: async (real) => {
          await real();
          if (lost) throw new TypeError("network lost");
          return real();
        },
      },
      { hasPlan: false },
    );
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.click(confirmButton());
    await waitFor(() => expect(confirmButton()).not.toHaveAttribute("aria-busy"));
    expect(navigation.router.replace).not.toHaveBeenCalled();
    lost = false;
    backend.calls.length = 0;
    await user.click(confirmButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    expect(backend.count(CHAT_KEY)).toBe(1);
    expect(backend.count(CONFIRM_KEY)).toBe(0);
  });
});

describe("failures (UI-screens S-34 States)", () => {
  it("keeps a message that was not sent with its text and a retry, and a warning in Slot T", async () => {
    const backend = makeBackend({ [MESSAGES_KEY]: () => apiError(503, "unavailable") });
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), "hello there{Enter}");
    expect(await screen.findByText("لم تُرسل الرسالة.")).toBeInTheDocument();
    expect(within(screen.getByRole("log")).getByText("hello there")).toBeInTheDocument();
    expect(screen.getByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(backend.count(MESSAGES_KEY)).toBe(1); // never retried on its own
  });

  it("retries by reading E33 first and sends again only what the server did not record", async () => {
    const backend = makeBackend({ [MESSAGES_KEY]: (_real, call) => (call === 1 ? apiError(503, "unavailable") : _real()) });
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), "something unclear{Enter}");
    await user.click(await screen.findByRole("button", { name: "إعادة المحاولة" }));
    await screen.findByText("المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.");
    expect(backend.calls.map((entry) => entry.key).slice(-3)).toEqual([MESSAGES_KEY, CHAT_KEY, MESSAGES_KEY]);
    expect(screen.queryByText("لم تُرسل الرسالة.")).not.toBeInTheDocument();
    expect(within(screen.getByRole("log")).getAllByText("something unclear")).toHaveLength(1);
  });

  it("does not resend a message the server already recorded when the answer was lost", async () => {
    const backend = makeBackend({
      [MESSAGES_KEY]: async (real, call) => {
        if (call === 1) {
          await real();
          throw new TypeError("network lost");
        }
        return real();
      },
    });
    await open({ backend });
    await ready();
    const user = userEvent.setup();
    await user.type(composer(), "something unclear{Enter}");
    await user.click(await screen.findByRole("button", { name: "إعادة المحاولة" }));
    await waitFor(() => expect(screen.queryByText("لم تُرسل الرسالة.")).not.toBeInTheDocument());
    expect(backend.count(MESSAGES_KEY)).toBe(1);
    expect(within(screen.getByRole("log")).getAllByText("something unclear")).toHaveLength(1);
    expect(screen.getByText("المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.")).toBeInTheDocument();
  });

  it("shows the throttle wording for a 429 and keeps the text for a retry", async () => {
    const backend = makeBackend();
    await open({ backend });
    await ready();
    await userEvent.setup().type(composer(), `${MOCK_CHAT_TEXTS.throttled}{Enter}`);
    expect(await screen.findByText("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.")).toBeInTheDocument();
    expect(screen.getByText("لم تُرسل الرسالة.")).toBeInTheDocument();
  });

  it("turns the thread read-only when E32 says the conversation was closed", async () => {
    const backend = makeBackend();
    const { created } = await open({ backend });
    await ready();
    await runtime.api.createPlanChat(request()); // replaces the open conversation
    await userEvent.setup().type(composer(), "hello{Enter}");
    expect(await screen.findByText("أُغلقت هذه المحادثة.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "اختصارات التعديل" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "اعتماد الخطة" })).not.toBeInTheDocument();
    expect(created.chatId).toBeTruthy();
  });

  it("shows the offline banner and no automatic-retry promise", async () => {
    const online = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await open();
    await ready();
    expect(screen.getByText("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.")).toBeInTheDocument();
    online.mockRestore();
  });
});

describe("loading, reload and the not-found and closed states (G-36, G-38)", () => {
  it("is busy with the dock absent while E33 is in flight", async () => {
    const gate = deferred<void>();
    const backend = makeBackend({ [CHAT_KEY]: async (real) => (await gate.promise, real()) });
    await open({ backend });
    expect(screen.getByRole("heading", { level: 1, name: "مراجعة الخطة مع المساعد" })).toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    gate.resolve();
    await ready();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("reloads the conversation through E33 with E11 and E18, never E31", async () => {
    const backend = makeBackend();
    await open({ backend });
    await ready();
    expect(backend.count(CHAT_KEY)).toBe(1);
    expect(backend.count("GET /api/me")).toBe(1);
    expect(backend.count("GET /api/today")).toBe(1);
    expect(backend.count("POST /api/plan-chats")).toBe(0);
  });

  it("shows not found for an unknown conversation, with «ابدأ من جديد» to S-08 and no dock", async () => {
    await open({ chatId: "66666666-6666-4666-8666-0000000000ff" });
    expect(await screen.findByText("لم نعثر على هذه المحادثة.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "ابدأ من جديد" }));
    expect(navigation.router.push).toHaveBeenCalledWith("/start");
  });

  it("shows not found at once for an id that cannot be a conversation id, without calling the API for it", async () => {
    const backend = makeBackend();
    await open({ backend, chatId: "..%2Fme" });
    expect(await screen.findByText("لم نعثر على هذه المحادثة.")).toBeInTheDocument();
    expect(backend.count(CHAT_KEY)).toBe(0);
  });

  it("shows a confirmed conversation read-only with «افتح اليوم»", async () => {
    const backend = makeBackend({}, { hasPlan: false });
    const { id } = await open({ backend });
    await ready();
    await userEvent.setup().click(confirmButton());
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/today"));
    // A reload of the same address (E33) now finds it confirmed.
    render(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <PlanChatScreen chatId={id} />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
    const notice = await screen.findByText("اعتُمدت هذه الخطة.");
    expect(notice).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "افتح اليوم" }));
    expect(navigation.router.push).toHaveBeenCalledWith("/today");
  });

  it("sends a signed-out visitor to S-01 with the session-ended banner and this path as next", async () => {
    const backend = makeBackend({ [CHAT_KEY]: () => apiError(401, "unauthenticated") });
    const { id } = await open({ backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(`/plan/chat/${id}`)}`));
    expect(peekLoginArrival()).toBe("session_ended");
  });

  it("shows a service error with «إعادة المحاولة» when E33 fails, and reads again on a press", async () => {
    const backend = makeBackend({ [CHAT_KEY]: (real, call) => (call === 1 ? apiError(503, "unavailable") : real()) });
    await open({ backend });
    expect(await screen.findByText("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    await ready();
    expect(backend.count(CHAT_KEY)).toBe(2);
  });
});
