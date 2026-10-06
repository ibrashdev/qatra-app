import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/games/word-order", useRouter: () => navigation.router }));

import { GameRoundScreen } from "@/components/games/GameRoundScreen";
import { clearRound, holdRound, peekRound } from "@/components/games/game-model";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { MOCK_GAME_RECALL_WORDS } from "@/lib/api/mock/game-handlers";
import type { EventsResponse, GameKind, SessionSnapshot } from "@/lib/api/types";
import { clearLoginArrival, peekLoginArrival } from "@/lib/auth/flash";
import { installDialogPolyfill } from "./dialog-polyfill";
import { apiError, E18, E20, E21, E22, jsonResponse, makeGamesBackend, PLAN, renderWithBackend, type GamesBackend } from "./games-support";

type User = ReturnType<typeof userEvent.setup>;

// The hub's side of the contract: E20 `game` answers a snapshot and the hub holds it in memory (UG-02) before the round route opens.
async function startRound(backend: GamesBackend, gameType: GameKind): Promise<SessionSnapshot> {
  const response = await backend.fetchImpl("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "game", planId: PLAN.planId, expectedPlanVersion: PLAN.planVersion, gameType }),
  });
  const snapshot = (await response.json()) as SessionSnapshot;
  holdRound({ snapshot, gameType, plan: PLAN, textKind: "quran" });
  return snapshot;
}

async function renderRound(gameType: GameKind, options: { language?: "ar" | "en"; backend?: GamesBackend } = {}) {
  const backend = options.backend ?? makeGamesBackend();
  await startRound(backend, gameType);
  const view = renderWithBackend(<GameRoundScreen gameType={gameType} />, { ...options, backend });
  await screen.findByRole("heading", { level: 2 });
  return view;
}

const primary = () => document.querySelector<HTMLButtonElement>("[data-round-primary]");
const stepHeading = () => document.querySelector<HTMLElement>("[data-step-heading]");
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const radio = (name: string) => screen.getByRole("radio", { name });

const placeInOrder = async (user: User, words: string[]) => {
  for (const word of words) await user.click(button(word));
};

// Word order: question 1 is in order ٢ ٣ ٤, question 2 is ٦ ٧ ٨.
async function answerOrder(user: User, wrong = false) {
  const heading = stepHeading()?.textContent ?? "";
  const first = heading.includes("Question 1");
  const words = first ? ["كلمة٢", "كلمة٣", "كلمة٤"] : ["كلمة٦", "كلمة٧", "كلمة٨"];
  await placeInOrder(user, wrong ? [...words].reverse() : words);
  await user.click(button("Check"));
}

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  clearRound();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  installDialogPolyfill();
  document.documentElement.style.overflow = "";
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a game round, entry (guard 7, UG-02)", () => {
  it("goes back to the games when nothing is held, as after a reload, and draws nothing", async () => {
    renderWithBackend(<GameRoundScreen gameType="word_order" />);
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/games"));
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("goes back to the games when the held round is another game's", async () => {
    const backend = makeGamesBackend();
    await startRound(backend, "word_choice");
    renderWithBackend(<GameRoundScreen gameType="word_order" />, { backend });
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/games"));
  });

  it("is a focus flow: the game name as H1, a back control named «Leave the round», no tab bar, no rail, no language switch", async () => {
    await renderRound("word_order");
    expect(screen.getByRole("heading", { level: 1, name: "Word order" })).toBeInTheDocument();
    expect(document.title).toBe("Word order · Qatra");
    expect(screen.getByRole("button", { name: "Leave the round" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("radio", { name: /English|العربية/ })).toBeNull();
  });

  it("never shows a timer, a score, a streak, a skip control or a translation", async () => {
    await renderRound("word_order");
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/score|streak|rank|certificate/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
    expect(screen.queryByText(/\d+\s*%/)).toBeNull();
  });
});

describe("S-15 word order", () => {
  it("shows the counter and the prompt as the H2, the helper, the pool and the explanatory cue", async () => {
    await renderRound("word_order");
    expect(stepHeading()).toHaveTextContent("Question 1 of 2");
    expect(stepHeading()).toHaveTextContent("Put the words in the order they appear in the text.");
    expect(screen.getByText("Tap a word to place it; tap it in the answer line to remove it.")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Mastery path · general steps" })).toBeInTheDocument();
    expect(primary()).toHaveTextContent("Check");
  });

  it("sends nothing for an incomplete answer: the error line, and focus on the first control that needs one", async () => {
    const user = userEvent.setup();
    const { backend } = await renderRound("word_order");
    await placeInOrder(user, ["كلمة٢"]);
    await user.click(button("Check"));
    expect(await screen.findByText("Place all the words first.")).toBeInTheDocument();
    expect(backend.count(E21)).toBe(0);
    expect(primary()).toHaveTextContent("Check");
  });

  it("checks a correct answer at once, shows only the success line, queues one E21 answer and turns the button into Next", async () => {
    const user = userEvent.setup();
    const { backend } = await renderRound("word_order");
    await answerOrder(user);
    expect(await screen.findByText("Correct.")).toBeInTheDocument();
    expect(primary()).toHaveTextContent("Next");
    expect(primary()).toHaveFocus();
    await waitFor(() => expect(backend.events().filter((event) => event.type === "answer")).toHaveLength(1));
    const [event] = backend.events();
    expect(event).toMatchObject({ type: "answer", hintUsed: false, answer: { order: ["1:1", "1:2", "1:3"] } });
    expect(event?.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("needs review gently, with the original, on a wrong order, and moves focus to the next question's H2", async () => {
    const user = userEvent.setup();
    await renderRound("word_order");
    await answerOrder(user, true);
    expect(await screen.findByText("This spot needs review. The original:")).toBeInTheDocument();
    expect(screen.getByText("كلمة٢ كلمة٣ كلمة٤")).toBeInTheDocument();
    await user.click(button("Next"));
    expect(stepHeading()).toHaveTextContent("Question 2 of 2");
    expect(stepHeading()).toHaveFocus();
    expect(primary()).toHaveTextContent("Check");
  });

  it("labels the last question's button «Finish the round» and ends in place on the result (P-25)", async () => {
    const user = userEvent.setup();
    const { backend } = await renderRound("word_order");
    await answerOrder(user);
    await user.click(button("Next"));
    await answerOrder(user, true);
    expect(await screen.findByRole("button", { name: "Finish the round" })).toBeInTheDocument();
    await user.click(button("Finish the round"));
    expect(await screen.findByRole("heading", { level: 1, name: "Round result" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("1 of 2 correct")).toBeInTheDocument());
    expect(backend.count(E22)).toBe(1);
    expect(screen.getByText("Answers")).toBeInTheDocument();
    expect(screen.queryByText(/With help/)).toBeNull();
    expect(screen.getByText(/Active time/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Daily progress" })).toBeInTheDocument();
    expect(screen.getByText("Parts that need review are added to your coming reviews.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Games" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Games" })).toBeInTheDocument();
    expect(screen.queryByText(/share|certificate|rank/i)).toBeNull();
    // Counts only: the answers row holds no percentage (the daily bar has its own, P-25).
    expect(screen.getByText("1 of 2 correct")).not.toHaveTextContent("%");
    // The sent answers came before E22, in order.
    const keys = backend.calls.map((call) => call.key);
    expect(keys.lastIndexOf(E21)).toBeLessThan(keys.indexOf(E22));
  });

  it("counts an answer with the hint as with help: the chip, the note, and «With help: 1» on the result", async () => {
    const user = userEvent.setup();
    const { backend } = await renderRound("word_order");
    await user.click(button("Hint"));
    expect(screen.getByText("With help")).toBeInTheDocument();
    expect(button("Hint")).toHaveAttribute("aria-disabled", "true");
    await placeInOrder(user, ["كلمة٣", "كلمة٤"]);
    await user.click(button("Check"));
    expect(await screen.findByText("An answer with help counts as practice, not as independent recall.")).toBeInTheDocument();
    await waitFor(() => expect(backend.events().find((event) => event.type === "answer")).toMatchObject({ hintUsed: true }));
    await user.click(button("Next"));
    await answerOrder(user);
    await user.click(button("Finish the round"));
    expect(await screen.findByText("With help: 1")).toBeInTheDocument();
  });
});

describe("S-16 word choice", () => {
  it("asks for the missing word, then for what comes next, and needs an answer first", async () => {
    const user = userEvent.setup();
    const { backend } = await renderRound("word_choice");
    expect(stepHeading()).toHaveTextContent("Choose the missing word.");
    await user.click(button("Check"));
    expect(await screen.findByText("Choose an answer first.")).toBeInTheDocument();
    expect(backend.count(E21)).toBe(0);
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("Correct.")).toBeInTheDocument();
    await user.click(button("Next"));
    expect(stepHeading()).toHaveTextContent("Choose what comes next.");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    await user.click(radio("كلمة٧ كلمة٨"));
    await user.click(button("Check"));
    expect(await screen.findByText("This spot needs review. The original:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish the round" })).toBeInTheDocument();
  });

  it("removes one wrong option with the hint, once", async () => {
    const user = userEvent.setup();
    await renderRound("word_choice");
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    await user.click(button("Hint"));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(button("Hint")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("S-17 similar distinction (D31)", () => {
  it("says what the hint does before the press, labels both tiles after the answer, and shows the original even when correct", async () => {
    const user = userEvent.setup();
    await renderRound("similar_distinction");
    expect(stepHeading()).toHaveTextContent("Choose the correct one as it appears in the book.");
    expect(screen.getByText("It removes the wrong option, leaving the correct one, and the answer counts as with help.")).toBeInTheDocument();
    await user.click(radio("متشابه١"));
    await user.click(button("Check"));
    expect(await screen.findByText("Correct.")).toBeInTheDocument();
    expect(screen.getByText("The correct one")).toBeInTheDocument();
    expect(screen.getByText("A memorization error")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "متشابه٢, a memorization error" })).toBeInTheDocument();
  });

  it("never repeats the wrong option outside its own tile: not in the feedback, a live region, a title or the events", async () => {
    const user = userEvent.setup();
    const { backend, container } = await renderRound("similar_distinction");
    await user.click(radio("متشابه٢"));
    await user.click(button("Check"));
    await screen.findByText("This spot needs review. The original:");
    const wrong = "متشابه٢";
    const tile = screen.getByRole("radio", { name: `${wrong}, a memorization error` });
    expect(tile).toBeInTheDocument();
    const outside = [...container.querySelectorAll("[role='status'], [aria-live], [title]")].map((element) => `${element.textContent}${element.getAttribute("title") ?? ""}`).join("");
    expect(outside).not.toContain(wrong);
    expect(JSON.stringify(backend.bodies(E21))).not.toContain(wrong);
  });

  it("shows only the correct tile once the hint has removed the wrong one, and does not select it", async () => {
    const user = userEvent.setup();
    await renderRound("similar_distinction");
    await user.click(button("Hint"));
    const remaining = screen.getAllByRole("radio");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveAttribute("aria-checked", "false");
  });

  it("shows the G-26 empty state with its own sentence, and sends nothing (P-24)", async () => {
    const backend = makeGamesBackend({}, {}, { empty: ["similar_distinction"] });
    await startRound(backend, "similar_distinction");
    renderWithBackend(<GameRoundScreen gameType="similar_distinction" />, { backend });
    expect(await screen.findByText("There is no similar position and no error recorded for you in this passage; try another game.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Choose another game" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/games");
    expect(peekRound("similar_distinction")).toBeNull();
    expect(backend.count(E21)).toBe(0);
    expect(backend.count(E22)).toBe(0);
  });
});

describe("S-18 word recall", () => {
  it("types one word, trims it, sends it once and shows the first-letter hint without filling the input", async () => {
    const user = userEvent.setup();
    const { backend } = await renderRound("word_recall");
    expect(stepHeading()).toHaveTextContent("Type the missing word.");
    expect(screen.getByText("Type the word in Arabic. Vowel marks are not needed.")).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "The missing word" });
    expect(input).toHaveAttribute("dir", "rtl");
    expect(input).toHaveAttribute("autocomplete", "off");
    await user.click(button("Hint"));
    expect(input).toHaveValue("");
    await user.type(input, `  ${MOCK_GAME_RECALL_WORDS[0]}  `);
    await user.click(button("Check"));
    expect(await screen.findByText("Correct.")).toBeInTheDocument();
    expect(input).toHaveAttribute("readonly");
    await waitFor(() => expect(backend.events().find((event) => event.type === "answer")).toMatchObject({ answer: { text: MOCK_GAME_RECALL_WORDS[0] }, hintUsed: true }));
  });

  it("asks for a word first and for one word only, and sends nothing for either", async () => {
    const user = userEvent.setup();
    const { backend } = await renderRound("word_recall");
    await user.click(button("Check"));
    expect(await screen.findByText("Type a word first.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "كلمة كلمة");
    await user.click(button("Check"));
    expect(await screen.findByText("Type one word only.")).toBeInTheDocument();
    expect(backend.count(E21)).toBe(0);
  });

  it("takes the server's original for a wrong word and does not repeat the typed text in the feedback", async () => {
    const user = userEvent.setup();
    await renderRound("word_recall");
    await user.type(screen.getByRole("textbox"), "خطأ");
    await user.click(button("Check"));
    expect(await screen.findByText("This spot needs review. The original:")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(new RegExp(MOCK_GAME_RECALL_WORDS[0])).closest("[data-feedback]")).not.toBeNull());
    expect(screen.getByText(new RegExp(MOCK_GAME_RECALL_WORDS[0])).closest("[data-feedback]")?.textContent).not.toContain("خطأ");
  });
});

describe("server grading and outcomes (P-21, P-22)", () => {
  it("says the answers are kept on this page only, beside the offline line, while the browser is offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await renderRound("word_order");
    expect(screen.getByText("There is no network connection. We will try again automatically, or press “Try again”.")).toBeInTheDocument();
    expect(screen.getByText("Your answers are kept on this page only until they are sent. Do not reload or close it.")).toBeInTheDocument();
  });

  it("replaces the first verdict with the server's, and says so politely (O-41)", async () => {
    const backend = makeGamesBackend({
      [E21]: async (real) => {
        const response = await real();
        const body = (await response.json()) as EventsResponse;
        return jsonResponse({ ...body, results: body.results.map((result) => ({ ...result, correct: !result.correct })) });
      },
    });
    const user = userEvent.setup();
    await renderRound("word_choice", { backend });
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("The result of this question was updated.")).toBeInTheDocument();
    expect(screen.getByText("This spot needs review. The original:")).toBeInTheDocument();
  });

  it("shows a calm line for a rejected answer and never resends it", async () => {
    const backend = makeGamesBackend({
      [E21]: async (real) => {
        const response = await real();
        const body = (await response.json()) as EventsResponse;
        return jsonResponse({ ...body, acknowledged: [], results: [], rejected: body.acknowledged.map((clientEventId) => ({ clientEventId, code: "out_of_scope" })) });
      },
    });
    const user = userEvent.setup();
    await renderRound("word_choice", { backend });
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("This answer was not counted.")).toBeInTheDocument();
    expect(backend.events().filter((event) => event.type === "answer")).toHaveLength(1);
    expect(screen.queryByText("This plan is not active.")).toBeNull();
  });

  it("ends the round with a warning when the plan stops being active (G-11): the answer area is inert and only «Back to Games» remains", async () => {
    const backend = makeGamesBackend({
      [E21]: async (real) => {
        const response = await real();
        const body = (await response.json()) as EventsResponse;
        return jsonResponse({ ...body, acknowledged: [], results: [], rejected: body.acknowledged.map((clientEventId) => ({ clientEventId, code: "plan_not_active" })) });
      },
    });
    const user = userEvent.setup();
    await renderRound("word_choice", { backend });
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("This plan is not active.")).toBeInTheDocument();
    expect(primary()).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to Games" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/games");
  });

  it("says «This round has ended.» for session_closed", async () => {
    const backend = makeGamesBackend({
      [E21]: async (real) => {
        const response = await real();
        const body = (await response.json()) as EventsResponse;
        return jsonResponse({ ...body, acknowledged: [], results: [], rejected: body.acknowledged.map((clientEventId) => ({ clientEventId, code: "session_closed" })) });
      },
    });
    const user = userEvent.setup();
    await renderRound("word_choice", { backend });
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("This round has ended.")).toBeInTheDocument();
  });

  it("removes the question and the original when the edition is gone (G-20, edition_mismatch)", async () => {
    const backend = makeGamesBackend({
      [E21]: async (real) => {
        const response = await real();
        const body = (await response.json()) as EventsResponse;
        return jsonResponse({ ...body, acknowledged: [], results: [], rejected: body.acknowledged.map((clientEventId) => ({ clientEventId, code: "edition_mismatch" })) });
      },
    });
    const user = userEvent.setup();
    await renderRound("word_choice", { backend });
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("This edition is no longer available. You can start a plan on another edition.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("كلمة٢")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to Games" })).toBeInTheDocument();
  });

  it("keeps playing from the local feedback when E21 cannot be reached, and resends the same ids on Try again", async () => {
    const backend = makeGamesBackend({
      [E21]: (real, call) => {
        if (call === 1) throw new TypeError("network");
        return real();
      },
    });
    const user = userEvent.setup();
    await renderRound("word_choice", { backend });
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    expect(await screen.findByText("Correct.")).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Try again" });
    await user.click(retry);
    await waitFor(() => expect(backend.count(E21)).toBe(2));
    const [first, second] = backend.bodies(E21) as { events: { clientEventId: string }[] }[];
    expect(second?.events[0]?.clientEventId).toBe(first?.events[0]?.clientEventId);
    expect(screen.getByText("Correct.")).toBeInTheDocument();
  });

  it("sends a visitor to the login with next=/games when E21 says the session ended (G-03)", async () => {
    const backend = makeGamesBackend({ [E21]: () => apiError(401, "unauthenticated") });
    const user = userEvent.setup();
    await renderRound("word_choice", { backend });
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login?next=%2Fgames"));
    expect(peekLoginArrival()).toBe("session_ended");
  });
});

describe("the leave sheet (P-23)", () => {
  it("opens from the back control with «Keep playing» as the initial focus, and Esc keeps playing", async () => {
    const user = userEvent.setup();
    await renderRound("word_order");
    await user.click(button("Leave the round"));
    const dialog = await screen.findByRole("dialog", { name: "Leave the round?" });
    expect(within(dialog).getByText(/We will save your answers so far, and a round cannot be resumed/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Keep playing" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "End the round and leave" })).toBeInTheDocument();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("opens from Esc on the page and from the browser back, instead of leaving", async () => {
    const user = userEvent.setup();
    await renderRound("word_order");
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("dialog", { name: "Leave the round?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep playing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    window.history.replaceState({ __NA: true }, "");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { __NA: true } }));
    });
    expect(await screen.findByRole("dialog", { name: "Leave the round?" })).toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("sends the pending answers, then E22, then goes to the games by replace and drops the snapshot", async () => {
    const user = userEvent.setup();
    const { backend } = await renderRound("word_choice");
    await user.click(radio("كلمة٢"));
    await user.click(button("Check"));
    await screen.findByText("Correct.");
    await user.click(button("Leave the round"));
    await user.click(await screen.findByRole("button", { name: "End the round and leave" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/games"));
    expect(backend.count(E22)).toBe(1);
    const keys = backend.calls.map((call) => call.key);
    expect(keys.lastIndexOf(E21)).toBeLessThan(keys.indexOf(E22));
    expect(peekRound("word_choice")).toBeNull();
  });

  it("stays open with an Error banner when the save fails, offers Try again first and Leave without saving second", async () => {
    const backend = makeGamesBackend({ [E22]: () => apiError(500, "internal") });
    const user = userEvent.setup();
    await renderRound("word_choice", { backend });
    await user.click(button("Leave the round"));
    await user.click(await screen.findByRole("button", { name: "End the round and leave" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("We could not save your latest answers.")).toBeInTheDocument();
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((entry) => entry.textContent)).toEqual(["Try again", "Leave without saving"]);
    expect(navigation.router.replace).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/games");
  });
});

describe("the result and playing again (P-19, P-25)", () => {
  async function playToTheResult(user: User, backend?: GamesBackend) {
    const view = await renderRound("word_order", { backend });
    await answerOrder(user);
    await user.click(button("Next"));
    await answerOrder(user);
    await user.click(button("Finish the round"));
    await screen.findByRole("heading", { level: 1, name: "Round result" });
    await screen.findByText("2 of 2 correct");
    return view;
  }

  it("shows no needs-review line when every answer was right, and moves focus to the result title", async () => {
    const user = userEvent.setup();
    await playToTheResult(user);
    expect(screen.queryByText("Parts that need review are added to your coming reviews.")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Round result" })).toHaveFocus();
  });

  it("goes back to the games from the back control and from «Games», without a sheet, by replace", async () => {
    const user = userEvent.setup();
    await playToTheResult(user);
    await user.click(screen.getByRole("button", { name: "Back to Games" }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/games");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts a new round of the same game with E20 and replaces the round in place", async () => {
    const user = userEvent.setup();
    const backend = makeGamesBackend();
    await playToTheResult(user, backend);
    const before = backend.count(E20);
    await user.click(screen.getByRole("button", { name: "Play again" }));
    await waitFor(() => expect(backend.count(E20)).toBe(before + 1));
    expect(backend.bodies(E20).at(-1)).toEqual({ kind: "game", planId: PLAN.planId, expectedPlanVersion: PLAN.planVersion, gameType: "word_order" });
    expect(await screen.findByRole("heading", { level: 1, name: "Word order" })).toBeInTheDocument();
    expect(stepHeading()).toHaveTextContent("Question 1 of 2");
    expect(screen.queryByText("2 of 2 correct")).toBeNull();
    expect(peekRound("word_order")?.snapshot.sessionId).not.toBe("");
  });

  it("explains a plan that moved on a replay with Refresh, which reads E18 and keeps the result", async () => {
    const user = userEvent.setup();
    const backend = makeGamesBackend({ [E20]: (real, call) => (call === 2 ? apiError(409, "version_conflict", { reason: "plan_version" }) : real()) });
    await playToTheResult(user, backend);
    await user.click(screen.getByRole("button", { name: "Play again" }));
    expect(await screen.findByText("Your plan was changed elsewhere. Refresh the page and try again.")).toBeInTheDocument();
    expect(screen.getByText("2 of 2 correct")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(backend.count(E18)).toBe(1));
    await waitFor(() => expect(screen.queryByText(/Your plan was changed elsewhere/)).toBeNull());
  });

  it("keeps a skeleton and shows a banner with Try again when E22 fails, then shows the result on the retry", async () => {
    const backend = makeGamesBackend({ [E22]: (real, call) => (call === 1 ? apiError(500, "internal") : real()) });
    const user = userEvent.setup();
    await renderRound("word_order", { backend });
    await answerOrder(user);
    await user.click(button("Next"));
    await answerOrder(user);
    await user.click(button("Finish the round"));
    expect(await screen.findByRole("heading", { level: 1, name: "Round result" })).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByText("Answers")).toBeNull();
    await user.click(retry);
    expect(await screen.findByText("2 of 2 correct")).toBeInTheDocument();
    expect(backend.count(E22)).toBe(2);
  });
});

describe("Arabic and right to left", () => {
  it("speaks the verbatim Arabic copy through a round", async () => {
    const user = userEvent.setup();
    await renderRound("word_order", { language: "ar" });
    expect(screen.getByRole("heading", { level: 1, name: "ترتيب الكلمات" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "مغادرة الجولة" })).toBeInTheDocument();
    expect(stepHeading()).toHaveTextContent("السؤال ١ من ٢");
    expect(stepHeading()).toHaveTextContent("رتّب الكلمات كما وردت في النص.");
    expect(screen.getByRole("note", { name: "مسار الإتقان · خطوات عامة" })).toBeInTheDocument();
    expect(primary()).toHaveTextContent("تحقق");
    await user.click(button("تحقق"));
    expect(await screen.findByText("رتّب جميع الكلمات أولًا.")).toBeInTheDocument();
    await user.click(button("مغادرة الجولة"));
    expect(await screen.findByRole("dialog", { name: "مغادرة الجولة؟" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "متابعة اللعب" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "إنهاء الجولة والخروج" })).toBeInTheDocument();
  });

  it("shows the cue under every game", async () => {
    for (const kind of ["word_order", "word_choice", "similar_distinction", "word_recall"] as const) {
      clearRound();
      const view = await renderRound(kind);
      expect(screen.getByRole("note", { name: "Mastery path · general steps" })).toBeInTheDocument();
      view.unmount();
    }
  });
});
