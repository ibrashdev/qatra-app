import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/games/word-order", useRouter: () => navigation.router }));

import { GameRoundScreen } from "@/components/games/GameRoundScreen";
import { clearRound, holdRound } from "@/components/games/game-model";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import type { GameKind, SessionSnapshot } from "@/lib/api/types";
import { clearLoginArrival } from "@/lib/auth/flash";
import { bindOnlineAccount, listOnlineEvents, readOnlineRun } from "@/lib/offline/online-journal";
import type { OnlineBinding } from "@/lib/offline/types";
import { installDialogPolyfill } from "./dialog-polyfill";
import { E21, E22, apiError, makeGamesBackend, PLAN, renderWithBackend, type GamesBackend } from "./games-support";
import { USERNAME, resetOfflineEnvironment } from "./offline-support";

// A game round of the online app with the online journal behind it: its answers are written to the device before they are counted (kind `game`), the
// foreground sync is told the round is live by a Web Lock, and a finish that cannot reach the server is owed with one key until the server answers. A
// reloaded game page starts a new round, so nothing about a round is restored here.

type User = ReturnType<typeof userEvent.setup>;

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

async function renderRound(options: { backend?: GamesBackend; language?: "ar" | "en" } = {}) {
  const backend = options.backend ?? makeGamesBackend();
  const snapshot = await startRound(backend, "word_order");
  const view = renderWithBackend(<GameRoundScreen gameType="word_order" />, { ...options, backend });
  await screen.findByRole("heading", { level: 2 });
  return { ...view, backend, snapshot };
}

const primary = () => document.querySelector<HTMLButtonElement>("[data-round-primary]");
const stepHeading = () => document.querySelector<HTMLElement>("[data-step-heading]");
const button = (name: string | RegExp) => screen.getByRole("button", { name });

async function answerOrder(user: User) {
  const first = (stepHeading()?.textContent ?? "").includes("Question 1");
  for (const word of first ? ["كلمة٢", "كلمة٣", "كلمة٤"] : ["كلمة٦", "كلمة٧", "كلمة٨"]) await user.click(button(word));
  await user.click(button("Check"));
  // The feedback comes after the answer is committed to the device.
  await waitFor(() => expect(primary()).not.toHaveTextContent("Check"));
}

const FINISH_PENDING_LINE = "The session is finished on this device. Its result will be confirmed when the connection is back.";
const SAVED_ON_DEVICE = "Saved on the device, waiting to sync";

let binding: OnlineBinding;
let online = true;

beforeEach(async () => {
  resetOfflineEnvironment();
  localStorage.clear();
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  clearRound();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  installDialogPolyfill();
  document.documentElement.style.overflow = "";
  window.history.replaceState(null, "", "/");
  binding = await bindOnlineAccount(USERNAME);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
});

const finishKeys = (backend: GamesBackend): (string | null)[] =>
  backend.fetchImpl.mock.calls
    .filter(([input, init]) => String(input).endsWith("/complete") && (init?.method ?? "GET").toUpperCase() === "POST")
    .map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));

describe("a game round with the online journal", () => {
  it("writes each answer to the journal as a `game` event of its own session before it counts, and settles it after the server answers", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const backend = makeGamesBackend({ [E21]: async (real) => (await gate, real()) });
    const user = userEvent.setup();
    const { snapshot } = await renderRound({ backend });
    await answerOrder(user);
    await waitFor(() => expect(backend.count(E21)).toBe(1));
    const stored = await listOnlineEvents(binding.accountKey);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "game", sessionId: snapshot.sessionId, state: "queued" });
    // No replay envelope, and the event is exactly what the server will be sent.
    expect(Object.keys(stored[0]?.event ?? {})).not.toEqual(expect.arrayContaining(["clientRunId", "snapshotId", "localSequence"]));
    release?.();
    await waitFor(async () => expect(await listOnlineEvents(binding.accountKey)).toHaveLength(0));
  });

  it("holds the run lock of its session while it is on screen and lets go when it closes", async () => {
    const held = new Set<string>();
    const request = vi.fn((name: string, callback: () => Promise<void> | undefined) => {
      held.add(name);
      return Promise.resolve(callback()).finally(() => held.delete(name));
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    const { snapshot, unmount } = await renderRound();
    await waitFor(() => expect([...held]).toEqual([`qatra-online-run:${snapshot.sessionId}`]));
    unmount();
    await waitFor(() => expect(held.size).toBe(0));
  });

  it("says the answers are saved on the device while the connection is gone", async () => {
    online = false;
    await renderRound();
    expect(await screen.findByText(SAVED_ON_DEVICE)).toBeInTheDocument();
    expect(screen.queryByText("Your answers are kept on this page only until they are sent. Do not reload or close it.")).toBeNull();
  });

  it("records the finish first, shows the provisional line when the server is out, retries with the identical key, and shows the confirmed result only after E22 answers", async () => {
    const backend = makeGamesBackend({ [E22]: (real, call) => (call === 1 ? apiError(503, "unavailable") : real()) });
    const user = userEvent.setup();
    const { snapshot } = await renderRound({ backend });
    await answerOrder(user);
    await user.click(button("Next"));
    await answerOrder(user);
    await user.click(button("Finish the round"));
    expect(await screen.findByText(FINISH_PENDING_LINE)).toBeInTheDocument();
    // The result area has no figures yet: the finish is only recorded.
    expect(screen.queryByText(/correct$/)).toBeNull();
    const owed = await readOnlineRun(binding.accountKey, snapshot.sessionId);
    expect(owed?.completion).toMatchObject({ state: "pending" });
    expect(owed?.kind).toBe("game");
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("2 of 2 correct")).toBeInTheDocument());
    expect(screen.queryByText(FINISH_PENDING_LINE)).toBeNull();
    const keys = finishKeys(backend);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(owed?.completion?.idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(await readOnlineRun(binding.accountKey, snapshot.sessionId)).toBeNull();
  });

  it("retries the finish by itself with the same key when the connection comes back", async () => {
    const backend = makeGamesBackend({ [E22]: (real, call) => (call === 1 ? apiError(503, "unavailable") : real()) });
    const user = userEvent.setup();
    await renderRound({ backend });
    await answerOrder(user);
    await user.click(button("Next"));
    await answerOrder(user);
    await user.click(button("Finish the round"));
    expect(await screen.findByText(FINISH_PENDING_LINE)).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(screen.getByText("2 of 2 correct")).toBeInTheDocument());
    const keys = finishKeys(backend);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});
