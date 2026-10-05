"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { freezeDeep } from "@/components/session/session-model";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { gamesMessages } from "@/i18n/games-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { startGameRound } from "@/lib/api/game-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import type { GameKind } from "@/lib/api/types";
import { classifyGameError, clearRound, holdRound, peekRound, roundQuestions, toTodayFailure, type GameRound } from "./game-model";
import { RoundRun } from "./RoundRun";
import type { ReplayState } from "./RoundResult";
import { RoundShell } from "./RoundShell";

// S-15 to S-18 at /games/word-order, /games/word-choice, /games/similar-distinction and /games/word-recall (UI-screens). The snapshot of E20 `game` is held in
// memory by the hub (UG-02), so a reload or a direct visit finds nothing and goes back to S-14 (guard 7). Replaying a round starts E20 again with the
// same game and plan and replaces the round here, in place (P-19, P-25).
export function GameRoundScreen({ gameType }: { gameType: GameKind }) {
  const router = useRouter();
  const { client, api } = useApiRuntime();
  const [round, setRound] = useState<GameRound | null>(() => peekRound(gameType));
  const [replay, setReplay] = useState<ReplayState>({ status: "idle" });
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (round === null) router.replace("/games");
  }, [round, router]);

  const questions = useMemo(() => (round === null ? [] : roundQuestions(round.snapshot)), [round]);

  if (round === null) return null;

  async function playAgain(current: GameRound) {
    if (replay.status === "starting") return;
    setReplay({ status: "starting" });
    let replaced = false;
    try {
      const snapshot = await startGameRound(client, { planId: current.plan.planId, planVersion: current.plan.planVersion, gameType: current.gameType });
      if (!mounted.current) return;
      if (typeof snapshot?.sessionId !== "string" || snapshot.sessionId === "" || !Array.isArray(snapshot.steps)) {
        setReplay({ status: "failed", failure: { kind: "internal" } });
        return;
      }
      const frozen = freezeDeep(snapshot);
      // The plan and its edition are the same, so the font of the book text is the one the first round settled.
      const next: GameRound = { ...current, snapshot: frozen };
      holdRound(next);
      replaced = true;
      setReplay({ status: "idle" });
      setRound(next);
      // The new round opens on its H1 (P-19).
      window.setTimeout(() => document.querySelector<HTMLElement>("[data-page-heading]")?.focus(), 0);
    } catch (error) {
      if (!mounted.current) return;
      const failure = toTodayFailure(classifyGameError(error));
      if (failure.kind === "session_ended") redirectToLogin(router, "/games");
      else if (failure.kind !== "aborted") setReplay({ status: "failed", failure });
    } finally {
      if (!replaced && mounted.current) setReplay((previous) => (previous.status === "starting" ? { status: "idle" } : previous));
    }
  }

  // «تحديث» after a version conflict re-reads E18 for the plan's current version; the learner presses «العب مرة أخرى» again.
  async function refreshPlan(current: GameRound) {
    try {
      const today = await api.today();
      if (!mounted.current) return;
      if (today.plan === null) {
        clearRound();
        router.replace("/games");
        return;
      }
      const next: GameRound = { ...current, plan: { planId: today.plan.planId, planVersion: today.plan.currentVersion } };
      holdRound(next);
      setRound((previous) => (previous === null ? previous : { ...previous, plan: next.plan }));
      setReplay({ status: "idle" });
    } catch (error) {
      if (!mounted.current) return;
      const failure = toTodayFailure(classifyGameError(error));
      if (failure.kind === "session_ended") redirectToLogin(router, "/games");
      else if (failure.kind !== "aborted") setReplay({ status: "failed", failure });
    }
  }

  if (questions.length === 0) return <EmptyRound gameType={round.gameType} />;

  return (
    <RoundRun
      key={round.snapshot.sessionId}
      round={round}
      questions={questions}
      replay={replay}
      onPlayAgain={() => void playAgain(round)}
      onRefreshPlan={() => void refreshPlan(round)}
    />
  );
}

// P-24 (G-26): E20 answered 201 with no question step. The round opens an empty state in place of the first question; nothing was answered, so there is no
// E21 or E22 call, and no question is invented (O-42).
function EmptyRound({ gameType }: { gameType: GameKind }) {
  const router = useRouter();
  const { locale } = useLocale();
  const t = gamesMessages(locale);
  const leave = () => {
    clearRound();
    router.replace("/games");
  };
  return (
    <RoundShell title={t.games[gameType].name} backLabel={t.round.leave} onBack={leave}>
      <div role="status" className="flex flex-col items-start gap-q16 rounded-md border border-divider bg-surface p-q16">
        <Icon name="info" size="lg" className="text-info-edge" />
        <p className="text-section text-ink">{gameType === "similar_distinction" ? t.round.empty.similar : t.round.empty.material}</p>
        <Button onClick={leave}>{t.round.empty.action}</Button>
      </div>
    </RoundShell>
  );
}
