import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/session/s-1/result", useRouter: () => navigation.router }));

import { ResultScreen } from "@/components/result/ResultScreen";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import type { CompleteResponse } from "@/lib/api/types";
import { clearSessionResult, holdSessionResult } from "@/lib/session/result-handoff";

const daily = { learningDate: "2026-10-05", dailyActiveMs: 420_000, dailyGoalMs: 600_000, dailyPercent: 70, dailyCompleted: false, extraActiveMs: 0 };
const complete = (summary: Partial<CompleteResponse["summary"]> = {}, dailyChange: Partial<CompleteResponse["daily"]> = {}): CompleteResponse => ({
  summary: { answered: 10, correct: 7, newPassages: 2, reviewsPassed: 3, reviewsFailed: 1, activeMs: 425_000, ...summary },
  daily: { ...daily, ...dailyChange },
});

function renderResult(result: CompleteResponse | null, { language = "ar", sessionId = "s-1", heldFor = "s-1" }: { language?: "ar" | "en"; sessionId?: string; heldFor?: string } = {}) {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  if (result !== null) holdSessionResult({ sessionId: heldFor, complete: result });
  return render(
    <LocaleProvider>
      <ResultScreen sessionId={sessionId} />
    </LocaleProvider>,
  );
}

const row = (label: string) => screen.getByText(label).closest("div") as HTMLElement;

beforeEach(() => {
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  clearSessionResult();
});

afterEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  clearSessionResult();
});

describe("S-20 Session result", () => {
  it("shows the H1 as the focus target and the summary as a definition list", async () => {
    renderResult(complete());
    const heading = await screen.findByRole("heading", { level: 1, name: "انتهت الجلسة" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAttribute("data-page-heading");
    const list = document.querySelector("dl") as HTMLElement;
    expect(list).not.toBeNull();
    expect(Array.from(list.querySelectorAll("dt")).map((term) => term.textContent)).toEqual(["الإجابات", "مقاطع جديدة", "مراجعات ناجحة", "مراجعات تعود في يوم التعلم التالي", "الوقت النشط"]);
    expect(row("الإجابات")).toHaveTextContent("٧ من ١٠ صحيحة");
    expect(row("مقاطع جديدة")).toHaveTextContent("٢");
    expect(row("مراجعات ناجحة")).toHaveTextContent("٣");
    expect(row("مراجعات تعود في يوم التعلم التالي")).toHaveTextContent("١");
  });

  it("rows are at least 56 px", () => {
    renderResult(complete());
    for (const item of Array.from(document.querySelectorAll("dl > div"))) expect(item.className).toContain("min-h-row");
  });

  it("shows the active time as m:ss in a left-to-right isolate", () => {
    renderResult(complete({ activeMs: 425_000 }));
    const value = row("الوقت النشط").querySelector("bdi") as HTMLElement;
    expect(value).toHaveAttribute("dir", "ltr");
    expect(value).toHaveTextContent("٧:٠٥");
    expect(row("الوقت النشط")).toHaveTextContent("٧:٠٥ دقائق");
  });

  it("shows conditional rows only when their count is above zero, the answers and time rows always", () => {
    renderResult(complete({ newPassages: 0, reviewsPassed: 0, reviewsFailed: 0 }));
    expect(screen.queryByText("مقاطع جديدة")).toBeNull();
    expect(screen.queryByText("مراجعات ناجحة")).toBeNull();
    expect(screen.queryByText("مراجعات تعود في يوم التعلم التالي")).toBeNull();
    expect(screen.getByText("الإجابات")).toBeInTheDocument();
    expect(screen.getByText("الوقت النشط")).toBeInTheDocument();
  });

  it("marks the returning-reviews row with an info icon and a calm label, never an error", () => {
    renderResult(complete());
    const term = screen.getByText("مراجعات تعود في يوم التعلم التالي");
    expect(term.querySelector("svg")).not.toBeNull();
    expect(term.className).not.toMatch(/error|warning/);
    expect(document.querySelector("dl")?.className ?? "").not.toMatch(/error|warning/);
  });

  it("says no answers were recorded when none were, without a percentage", () => {
    renderResult(complete({ answered: 0, correct: 0 }));
    expect(screen.getByText("لم تُسجَّل إجابات في هذه الجلسة.")).toBeInTheDocument();
    expect(screen.queryByText(/صحيحة/)).toBeNull();
    expect(document.querySelector("dl")?.textContent ?? "").not.toMatch(/٪|%/);
  });

  it("shows counts, never an accuracy percentage", () => {
    renderResult(complete({ answered: 10, correct: 7 }));
    expect(document.querySelector("dl")?.textContent ?? "").not.toMatch(/٪|%/);
  });

  it("shows the daily indicator with the bar and the value in words", () => {
    renderResult(complete());
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "70");
    expect(bar).toHaveAttribute("aria-valuetext", "٧ من ١٠ دقائق، ٧٠ بالمئة");
    expect(bar).toHaveAccessibleName("الإنجاز اليومي");
    expect(document.body).toHaveTextContent("٧/١٠ دقائق، ٧٠٪");
    expect(screen.queryByText("أكملت هدف اليوم")).toBeNull();
    expect(screen.queryByText(/إضافية/)).toBeNull();
  });

  it("adds the extra-time line, with the bar capped, when time went past the goal", () => {
    renderResult(complete({}, { dailyActiveMs: 720_000, dailyPercent: 100, extraActiveMs: 120_000 }));
    expect(screen.getByText("+ ٢ دقيقة إضافية")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.queryByText("أكملت هدف اليوم")).toBeNull(); // the completion line follows dailyCompleted only
  });

  it("shows the completion line, and announces it once in a polite region", async () => {
    renderResult(complete({}, { dailyActiveMs: 600_000, dailyPercent: 100, dailyCompleted: true }));
    expect(screen.getAllByText("أكملت هدف اليوم")).toHaveLength(1); // the visible line; the region is still empty
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
    await waitFor(() => expect(region).toHaveTextContent("أكملت هدف اليوم"));
    expect(screen.getAllByText("أكملت هدف اليوم")).toHaveLength(2);
  });

  it("announces nothing when the goal was not reached", async () => {
    renderResult(complete());
    const region = screen.getByRole("status");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(region).toBeEmptyDOMElement();
  });

  it("offers the primary action, the secondary one and the link, to the specified destinations", () => {
    renderResult(complete());
    const primary = screen.getByRole("link", { name: "العودة إلى اليوم" });
    expect(primary).toHaveAttribute("href", "/today");
    expect(primary.className).toContain("bg-primary");
    expect(primary.className).toContain("w-full");
    expect(screen.getByRole("link", { name: "تدريب إضافي" })).toHaveAttribute("href", "/games");
    expect(screen.getByRole("link", { name: "عرض تقدمك" })).toHaveAttribute("href", "/progress");
    const order = screen.getAllByRole("link").map((link) => link.textContent);
    expect(order).toEqual(["العودة إلى اليوم", "تدريب إضافي", "عرض تقدمك"]);
  });

  it("leaves out confetti, a score card, a share action, a certificate and a ranking", () => {
    renderResult(complete());
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(document.body.textContent ?? "").not.toMatch(/شارك|مشاركة|شهادة|ترتيب|نتيجتك|Share|Score|Rank/);
    expect(document.querySelector("img, canvas")).toBeNull();
  });

  it("never reads the network: it only shows the answer S-19 held", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderResult(complete());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not redirect when the answer is held", () => {
    renderResult(complete());
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });
});

describe("S-20 reload, direct visit and another session", () => {
  it("goes to S-21 when nothing is held, and renders nothing meanwhile", async () => {
    const { container } = renderResult(null);
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/progress"));
    expect(navigation.router.replace).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("goes to S-21 when the held answer belongs to another session", async () => {
    const { container } = renderResult(complete(), { sessionId: "s-2", heldFor: "s-1" });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/progress"));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("S-20 English", () => {
  it("shows the English copy and LTR-isolated time", () => {
    renderResult(complete(), { language: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "The session is over" })).toBeInTheDocument();
    expect(row("Answers")).toHaveTextContent("7 of 10 correct");
    expect(screen.getByText("New passages")).toBeInTheDocument();
    expect(screen.getByText("Reviews passed")).toBeInTheDocument();
    expect(screen.getByText("Reviews coming back on the next learning day")).toBeInTheDocument();
    expect(row("Active time")).toHaveTextContent("7:05 minutes");
    expect(within(row("Active time")).getByText("7:05")).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("link", { name: "Back to Today" })).toHaveAttribute("href", "/today");
    expect(screen.getByRole("link", { name: "Extra practice" })).toHaveAttribute("href", "/games");
    expect(screen.getByRole("link", { name: "View your progress" })).toHaveAttribute("href", "/progress");
    expect(document.body).toHaveTextContent("7/10 minutes, 70%");
  });

  it("says no answers were recorded in English", () => {
    renderResult(complete({ answered: 0, correct: 0 }), { language: "en" });
    expect(screen.getByText("No answers were recorded in this session.")).toBeInTheDocument();
  });
});
