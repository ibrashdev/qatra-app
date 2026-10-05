import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/lessons", useRouter: () => navigation.router }));

import { LessonsScreen } from "@/components/lessons/LessonsScreen";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import type { LessonsResponse } from "@/lib/api/types";
import { MOCK_PLAN_ID } from "@/lib/api/mock/fixtures";
import { apiError, E20, E21, jsonResponse, makeGamesBackend, renderWithBackend, type GamesBackend } from "./games-support";

const LESSONS = "GET /api/lessons";

function renderList(options: { language?: "ar" | "en"; backend?: GamesBackend } = {}) {
  return renderWithBackend(<LessonsScreen />, options);
}

const cards = () => screen.getAllByRole("link").filter((link) => link.hasAttribute("data-section"));
const ready = () => screen.findByRole("list", { name: /passages|مقاطع/ });

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the lessons list, populated", () => {
  it("shows the H1, the lead and one card per section of the plan, in the plan's order, each a link to its reader", async () => {
    const { backend } = renderList();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "Lessons" })).toBeInTheDocument();
    expect(document.title).toBe("Lessons · Qatra");
    expect(screen.getByText(/with no questions and no games/)).toBeInTheDocument();
    expect(cards().map((card) => card.getAttribute("href"))).toEqual(["/lessons/1", "/lessons/2"]);
    expect(cards().map((card) => card.getAttribute("data-section"))).toEqual(["1", "2"]);
    expect(backend.count(LESSONS)).toBe(1);
  });

  it("names each card by its Arabic reference and describes a surah by its passage count, with a decorative icon", async () => {
    renderList();
    await ready();
    const [first, second] = cards();
    expect(first).toHaveAccessibleName("سورة اصطناعية ١");
    expect(first).toHaveAccessibleDescription("2 passages");
    expect(second).toHaveAccessibleName("سورة اصطناعية ٢");
    expect(second).toHaveAccessibleDescription("1 passage");
    for (const card of cards()) {
      expect(card.querySelectorAll("svg").length).toBeGreaterThan(0);
      expect([...card.querySelectorAll("svg")].every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
    }
    expect(within(first as HTMLElement).getByText("سورة اصطناعية ١").closest("bdi")).toHaveAttribute("lang", "ar");
  });

  it("speaks Arabic: the tab name as the H1, the lead and the passage counts with their agreement", async () => {
    renderList({ language: "ar" });
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "الدروس" })).toBeInTheDocument();
    expect(document.title).toBe("الدروس · قطرة غيث");
    expect(screen.getByText(/دون أسئلة ولا ألعاب/)).toBeInTheDocument();
    expect(cards()[0]).toHaveAccessibleDescription("مقطعان");
    expect(cards()[1]).toHaveAccessibleDescription("مقطع واحد");
  });

  it("offers nothing to answer or play: no button, no field, no score, and starts no session", async () => {
    const { backend } = renderList();
    await ready();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/score|game over|unlock/i)).toBeNull();
    expect(backend.count(E20)).toBe(0);
    expect(backend.count(E21)).toBe(0);
  });

  it("shows a hadith by its title alone, with no passage count (its passages are the paths of one narration)", async () => {
    const hadith: LessonsResponse = {
      planId: MOCK_PLAN_ID,
      planVersion: 1,
      sections: [
        { sectionId: 3, kind: "hadith", referenceAr: "حديث اصطناعي ٣", passageCount: 3 },
        { sectionId: 4, kind: "hadith", referenceAr: "حديث اصطناعي ٤", passageCount: 1 },
      ],
    };
    renderList({ backend: makeGamesBackend({ [LESSONS]: () => jsonResponse(hadith) }) });
    await ready();
    expect(cards().map((card) => card.getAttribute("href"))).toEqual(["/lessons/3", "/lessons/4"]);
    expect(cards()[0]).toHaveAccessibleName("حديث اصطناعي ٣");
    expect(cards()[0]).not.toHaveAccessibleDescription();
  });
});

describe("the lessons list, states", () => {
  it("shows the hidden loading text at once and a skeleton after 300 ms, then the list", async () => {
    const backend = makeGamesBackend({ [LESSONS]: async (real) => (await new Promise((resolve) => setTimeout(resolve, 600)), real()) });
    renderList({ backend });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText("Loading")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[aria-busy="true"] [aria-hidden="true"]')).not.toBeNull());
    await ready();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("keeps the tab for an account with no plan: the empty state points to the start of a plan, with no list", async () => {
    renderList({ backend: makeGamesBackend({}, { hasPlan: false }) });
    expect(await screen.findByText("There is no active plan yet.")).toBeInTheDocument();
    expect(screen.getByText(/Lessons show the passages of your active plan/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start your plan" })).toHaveAttribute("href", "/start");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("says there is nothing to read for an active plan whose scope holds no section", async () => {
    const empty: LessonsResponse = { planId: MOCK_PLAN_ID, planVersion: 1, sections: [] };
    renderList({ backend: makeGamesBackend({ [LESSONS]: () => jsonResponse(empty) }) });
    expect(await screen.findByText("There is nothing to read yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows the Error banner with Try again on a failed read, and reads again", async () => {
    const backend = makeGamesBackend({ [LESSONS]: (real, call) => (call === 1 ? apiError(500, "internal") : real()) });
    const user = userEvent.setup();
    renderList({ backend });
    expect(await screen.findByText("Something unexpected happened. Try again.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(backend.count(LESSONS)).toBe(2);
  });

  it("shows the withdrawn-edition banner when the server no longer has the edition (404)", async () => {
    renderList({ backend: makeGamesBackend({ [LESSONS]: () => apiError(404, "not_found") }) });
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("sends a visitor whose session ended to the login screen and back here", async () => {
    renderList({ backend: makeGamesBackend({}, { signedIn: false }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Flessons"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});
