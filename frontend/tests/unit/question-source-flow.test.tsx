import { screen } from "@testing-library/react";
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
import { installDialogPolyfill } from "./dialog-polyfill";
import { makeGamesBackend, PLAN, renderWithBackend } from "./games-support";

// D90 in a game round: the whole passage is in the question from the start, and the source line (book, human reference, «المصدر» link) comes only
// with the feedback after the answer, never before it, and never with the provider name, the edition label or a technical code.
async function renderRound(gameType: GameKind) {
  const backend = makeGamesBackend();
  const response = await backend.fetchImpl("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "game", planId: PLAN.planId, expectedPlanVersion: PLAN.planVersion, gameType }),
  });
  holdRound({ snapshot: (await response.json()) as SessionSnapshot, gameType, plan: PLAN, textKind: "quran" });
  renderWithBackend(<GameRoundScreen gameType={gameType} />, { language: "ar", backend });
  await screen.findByRole("heading", { level: 2 });
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
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a game round, source line (D90)", () => {
  it("shows the whole passage with the part's place for word order, and the source only after the answer", async () => {
    await renderRound("word_order");
    const user = userEvent.setup();
    const place = screen.getByRole("img", { name: "الجزء الناقص" });
    expect(place.parentElement).toHaveTextContent("كلمة١ كلمة٥"); // the first mock passage: the part sits between the first and the last word
    expect(document.body.textContent).not.toContain("كتاب اصطناعي");
    expect(screen.queryByRole("link", { name: /المصدر/ })).toBeNull();
    for (const word of ["كلمة٢", "كلمة٣", "كلمة٤"]) await user.click(screen.getByRole("button", { name: word }));
    await user.click(screen.getByRole("button", { name: "تحقق" }));
    expect(await screen.findByText(/كتاب اصطناعي/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /^المصدر:/ });
    expect(link).toHaveAttribute("href", "https://example.invalid/ref/1");
    expect(link).toHaveTextContent("المصدر");
    for (const hidden of ["نسخة اصطناعية", "ناشر اصطناعي", "example.invalid", "1:1"]) expect(document.body.textContent).not.toContain(hidden);
  });

  it("shows the whole passage for a choice question and the source only after the answer", async () => {
    await renderRound("word_choice");
    const user = userEvent.setup();
    const blank = screen.getByRole("img", { name: "الكلمة الناقصة" });
    expect(blank.parentElement).toHaveTextContent("كلمة١ كلمة٣ كلمة٤ كلمة٥");
    expect(screen.queryByRole("link", { name: /المصدر/ })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "كلمة٢" }));
    await user.click(screen.getByRole("button", { name: "تحقق" }));
    expect(await screen.findByRole("link", { name: /^المصدر:/ })).toBeInTheDocument();
  });
});
