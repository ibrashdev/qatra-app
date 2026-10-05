import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/games", useRouter: () => navigation.router }));

import { GamesHubScreen } from "@/components/games/GamesHubScreen";
import { clearRound, GAMES, peekRound } from "@/components/games/game-model";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { apiError, E18, E20, makeGamesBackend, PLAN, renderWithBackend, type GamesBackend } from "./games-support";

function renderHub(options: { language?: "ar" | "en"; backend?: GamesBackend } = {}) {
  return renderWithBackend(<GamesHubScreen />, options);
}

const rows = () => screen.getAllByRole("button").filter((button) => button.hasAttribute("data-game"));
const ready = () => screen.findByRole("list");

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  clearRound();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S-14 games hub, populated (FC-12)", () => {
  it("shows the H1, the plan line, the fixed notice and exactly the four approved games in the approved order", async () => {
    renderHub();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "Games" })).toBeInTheDocument();
    expect(document.title).toBe("Games · Qatra");
    expect(screen.getByText(/From your active plan:/)).toHaveTextContent("From your active plan: Book title (placeholder)");
    expect(screen.getByText(/Questions come from your plan's material and edition/)).toBeInTheDocument();
    expect(rows().map((row) => row.getAttribute("data-game"))).toEqual(["word_order", "word_choice", "similar_distinction", "word_recall"]);
    expect(rows().map((row) => row.getAttribute("data-game"))).toEqual(GAMES.map((game) => game.kind));
  });

  it("gives every row a text name and a description, tied by aria-labelledby and aria-describedby, and an icon that is decoration only", async () => {
    renderHub();
    await ready();
    const names = ["Word order", "Word or segment choice", "Similar distinction", "Word recall"];
    const descriptions = [
      "Put the words of a part of the text in their original order.",
      "Choose the word or connected part that completes the text.",
      "Choose the correct one of two similar options as it appears in the book.",
      "Type the missing word from memory.",
    ];
    rows().forEach((row, position) => {
      expect(row).toHaveAccessibleName(names[position] ?? "");
      expect(row).toHaveAccessibleDescription(descriptions[position] ?? "");
      expect(row.querySelectorAll("svg").length).toBeGreaterThan(0);
      expect([...row.querySelectorAll("svg")].every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
    });
    // FC-12: distinct icons, so no two games share a glyph (the first svg of a row is its own icon).
    const glyphs = rows().map((row) => row.querySelector("svg")?.getAttribute("class")?.split(" ").find((name) => name.startsWith("lucide-")) ?? "");
    expect(new Set(glyphs).size).toBe(4);
  });

  it("offers no picker, no score, no lock and no pre-disabled row", async () => {
    renderHub();
    await ready();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/score|unlock|leaderboard/i)).toBeNull();
    expect(rows().every((row) => !row.hasAttribute("aria-disabled"))).toBe(true);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("reads E18 and the catalog, and starts nothing before a press", async () => {
    const { backend } = renderHub();
    await ready();
    expect(backend.count(E18)).toBe(1);
    expect(backend.count(E20)).toBe(0);
  });

  it("speaks Arabic with the verbatim names, descriptions and plan line", async () => {
    renderHub({ language: "ar" });
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "الألعاب" })).toBeInTheDocument();
    expect(rows().map((row) => row.getAttribute("aria-labelledby"))).toHaveLength(4);
    expect(screen.getByRole("button", { name: "ترتيب الكلمات" })).toHaveAccessibleDescription("رتّب كلمات جزء من النص كما وردت.");
    expect(screen.getByRole("button", { name: "اختيار كلمة أو جزء" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تمييز المتشابه" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "استرجاع كلمة" })).toBeInTheDocument();
    expect(screen.getByText(/من خطتك النشطة:/)).toBeInTheDocument();
  });
});

describe("S-14 games hub, loading and read failures", () => {
  it("shows the hidden loading text at once and the skeleton after 300 ms, then the rows", async () => {
    const backend = makeGamesBackend({ [E18]: async (real) => (await new Promise((resolve) => setTimeout(resolve, 600)), real()) });
    renderHub({ backend });
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText("Loading")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[aria-busy="true"] [aria-hidden="true"]')).not.toBeNull());
    await ready();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("shows the empty state for an account with no plan (G-24) and keeps the notice, with no rows", async () => {
    renderHub({ backend: makeGamesBackend({}, { hasPlan: false }) });
    expect(await screen.findByText("There is no active plan yet.")).toBeInTheDocument();
    expect(screen.getByText("Games need an active plan to choose material from.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start your plan" })).toHaveAttribute("href", "/start");
    expect(screen.getByText(/Questions come from your plan's material/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button").filter((button) => button.hasAttribute("data-game"))).toHaveLength(0);
  });

  it("hides the rows on an E18 failure, shows the Error banner with Try again, and loads again", async () => {
    const backend = makeGamesBackend({ [E18]: (real, call) => (call === 1 ? apiError(500, "internal") : real()) });
    const user = userEvent.setup();
    renderHub({ backend });
    expect(await screen.findByText("Something unexpected happened. Try again.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(backend.count(E18)).toBe(2);
  });

  it("sends a visitor to the login with next=/games and raises the session-ended banner (G-03)", async () => {
    renderHub({ backend: makeGamesBackend({}, { signedIn: false }) });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fgames"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("S-14 games hub, starting a round (P-19)", () => {
  it("sends E20 game with the plan and the game type and nothing else, holds the snapshot in memory and opens the round route", async () => {
    const user = userEvent.setup();
    const { backend } = renderHub();
    await ready();
    await user.click(screen.getByRole("button", { name: "Similar distinction" }));
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith("/games/similar-distinction"));
    expect(backend.bodies(E20)).toEqual([{ kind: "game", planId: PLAN.planId, expectedPlanVersion: PLAN.planVersion, gameType: "similar_distinction" }]);
    const held = peekRound("similar_distinction");
    expect(held?.snapshot.kind).toBe("game");
    expect(held?.plan).toEqual(PLAN);
    expect(peekRound("word_order")).toBeNull();
  });

  it("opens each of the four round routes of the spec", async () => {
    const expected: [string, string][] = [
      ["Word order", "/games/word-order"],
      ["Word or segment choice", "/games/word-choice"],
      ["Similar distinction", "/games/similar-distinction"],
      ["Word recall", "/games/word-recall"],
    ];
    for (const [name, route] of expected) {
      // The pressed row keeps its loading state while the round opens, so each game starts from a fresh hub, as a return from a round does.
      navigation.router.push.mockReset();
      const user = userEvent.setup();
      const view = renderHub();
      await ready();
      await user.click(screen.getByRole("button", { name }));
      await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith(route));
      view.unmount();
    }
  });

  it("puts the pressed row in Loading, keeps the others inert, announces the start, and never repeats the call", async () => {
    const backend = makeGamesBackend({ [E20]: async (real) => (await new Promise((resolve) => setTimeout(resolve, 200)), real()) });
    const user = userEvent.setup();
    renderHub({ backend });
    await ready();
    const pressed = screen.getByRole("button", { name: "Word order" });
    await user.click(pressed);
    expect(pressed).toHaveAttribute("aria-busy", "true");
    const others = rows().filter((row) => row !== pressed);
    expect(others.every((row) => row.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(await screen.findByText("Starting the round")).toBeInTheDocument();
    await user.click(others[0] as HTMLElement);
    await user.click(pressed);
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledTimes(1));
    expect(backend.count(E20)).toBe(1);
  });

  it("explains a plan that moved (G-09) with Refresh, which reads E18 again, and keeps the rows", async () => {
    const backend = makeGamesBackend({ [E20]: (real, call) => (call === 1 ? apiError(409, "version_conflict", { reason: "plan_version" }) : real()) });
    const user = userEvent.setup();
    renderHub({ backend });
    await ready();
    await user.click(screen.getByRole("button", { name: "Word order" }));
    expect(await screen.findByText("Your plan was changed elsewhere. Refresh the page and try again.")).toBeInTheDocument();
    expect(rows()).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(backend.count(E18)).toBe(2));
    await waitFor(() => expect(screen.queryByText(/Your plan was changed elsewhere/)).toBeNull());
  });

  it("explains an inactive plan (G-11) with Refresh", async () => {
    const backend = makeGamesBackend({ [E20]: () => apiError(409, "version_conflict", { reason: "plan_not_active" }) });
    const user = userEvent.setup();
    renderHub({ backend });
    await ready();
    await user.click(screen.getByRole("button", { name: "Word recall" }));
    expect(await screen.findByText("This plan is not active.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("hides the rows and offers a new plan when the edition or the scope is gone (G-20), for both codes", async () => {
    for (const details of [{ reason: "edition_not_available" }, { fields: [{ field: "planId", rule: "out_of_scope" }] }]) {
      const backend = makeGamesBackend({ [E20]: () => apiError(422, "validation_error", details) });
      const user = userEvent.setup();
      const view = renderHub({ backend });
      await ready();
      await user.click(screen.getByRole("button", { name: "Word order" }));
      expect(await screen.findByText("This edition is no longer available. You can start a plan on another edition.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Start your plan" })).toHaveAttribute("href", "/start");
      expect(screen.queryByRole("list")).toBeNull();
      view.unmount();
    }
  });

  it("shows the generic outage banner for a server error on E20, keeps the rows, and resends nothing by itself", async () => {
    const backend = makeGamesBackend({ [E20]: () => apiError(500, "internal") });
    const user = userEvent.setup();
    renderHub({ backend });
    await ready();
    await user.click(screen.getByRole("button", { name: "Word or segment choice" }));
    expect(await screen.findByText("Something unexpected happened. Try again.")).toBeInTheDocument();
    expect(rows()).toHaveLength(4);
    expect(within(rows()[1] as HTMLElement).queryByRole("status")).toBeNull();
    await act(async () => undefined);
    expect(backend.count(E20)).toBe(1);
    expect(navigation.router.push).not.toHaveBeenCalled();
  });

  it("goes to the login when E20 says the session ended (G-03)", async () => {
    const backend = makeGamesBackend({ [E20]: () => apiError(401, "unauthenticated") });
    const user = userEvent.setup();
    renderHub({ backend });
    await ready();
    await user.click(screen.getByRole("button", { name: "Word order" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fgames"));
  });

  it("treats a snapshot without a session id as an internal error", async () => {
    const backend = makeGamesBackend({ [E20]: () => new Response(JSON.stringify({ steps: [] }), { status: 201, headers: { "Content-Type": "application/json" } }) });
    const user = userEvent.setup();
    renderHub({ backend });
    await ready();
    await user.click(screen.getByRole("button", { name: "Word order" }));
    expect(await screen.findByText("Something unexpected happened. Try again.")).toBeInTheDocument();
    expect(navigation.router.push).not.toHaveBeenCalled();
  });
});
