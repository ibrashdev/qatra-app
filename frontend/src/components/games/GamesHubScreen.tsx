"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { LinkButton } from "@/components/progress/LinkButton";
import { freezeDeep, textKindOf } from "@/components/session/session-model";
import { isAlertFailure, type TodayFailure } from "@/components/today/today-failure";
import { BannerSlot } from "@/components/ui/FormBanners";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { PageTitle } from "@/components/ui/PageTitle";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { gamesMessages, type GamesMessages } from "@/i18n/games-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { renderTemplate } from "@/i18n/template";
import { startGameRound } from "@/lib/api/game-endpoints";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import type { CatalogEdition, GameKind, Plan } from "@/lib/api/types";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { GAMES, classifyGameError, holdRound, toTodayFailure, type GameEntry } from "./game-model";
import { StartFailureBanner } from "./StartFailureBanner";
import { useGamesHub } from "./use-games-hub";

const SKELETON_DELAY_MS = 300; // UI-tokens 6.14

// S-14 Games hub (UI-screens Batch 3, FC-12 of docs/Figma-code-handoff.md): four equal rows, one per game, each with a text name, a description and a
// supplemental icon. A press starts a round with E20 `game` (P-19) and opens the round route with the snapshot held in memory only. There is no book or
// section picker, no score, no lock and no pre-disabled row: a game with nothing to play says so on its round (P-24).
export function GamesHubScreen() {
  const { locale, messages } = useLocale();
  const t = gamesMessages(locale);
  const router = useRouter();
  const { client } = useApiRuntime();
  const wake = useWakeUpState();
  const { online } = useConnectivity();
  const { state, reload } = useGamesHub();
  const showSkeleton = useAfterDelay(SKELETON_DELAY_MS);
  const bannerId = useId();

  const [starting, setStarting] = useState<GameKind | null>(null);
  const [startFailure, setStartFailure] = useState<TodayFailure | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const failure: TodayFailure | null = startFailure ?? (state.status === "error" ? toTodayFailure(state.failure) : null);

  // G-03: the session ended. S-01 shows its banner once and brings the learner back here.
  useEffect(() => {
    if (failure?.kind === "session_ended") redirectToLogin(router, "/games");
  }, [failure?.kind, router]);

  // P-04: a read that failed while the server was waking is sent again once health answers, once per wake-up (a press is never resent, P-19).
  const autoReloaded = useRef(false);
  useEffect(() => {
    if (wake.phase !== "ready") {
      autoReloaded.current = false;
      return;
    }
    if (!autoReloaded.current && state.status === "error" && state.failure.kind === "connectivity") {
      autoReloaded.current = true;
      reload();
    }
  }, [wake.phase, state, reload]);

  function refresh() {
    setStartFailure(null);
    reload();
  }

  async function start(game: GameEntry, plan: Plan, editions: readonly CatalogEdition[] | null) {
    if (starting !== null) return;
    setStartFailure(null);
    setStarting(game.kind);
    let leaving = false;
    try {
      const snapshot = await startGameRound(client, { planId: plan.planId, planVersion: plan.currentVersion, gameType: game.kind });
      if (!mounted.current) return;
      if (typeof snapshot?.sessionId !== "string" || snapshot.sessionId === "" || !Array.isArray(snapshot.steps)) {
        setStartFailure({ kind: "internal" });
        return;
      }
      const frozen = freezeDeep(snapshot);
      holdRound({ snapshot: frozen, gameType: game.kind, plan: { planId: plan.planId, planVersion: plan.currentVersion }, textKind: textKindOf(frozen, editions) });
      leaving = true;
      router.push(game.route);
    } catch (error) {
      if (!mounted.current) return;
      const next = toTodayFailure(classifyGameError(error));
      if (next.kind !== "aborted") setStartFailure(next);
    } finally {
      // On success the row keeps its loading state while the round opens.
      if (!leaving && mounted.current) setStarting(null);
    }
  }

  const waking = wake.phase === "waking" || wake.phase === "timed_out";
  const ready = state.status === "ready" ? state : null;
  const plan = ready?.plan ?? null;
  const unavailable = failure?.kind === "revoked";
  // G-20: a retry cannot succeed, so the rows go. An E18 failure hides them too, until E18 answers.
  const showRows = ready !== null && plan !== null && !unavailable;
  const alertFailure = failure !== null && isAlertFailure(failure);

  const failureNode =
    failure === null ? null : (
      <StartFailureBanner failure={failure} id={bannerId} online={online} waking={waking} onRetry={startFailure === null ? reload : undefined} onRefresh={refresh} />
    );
  return (
    <div>
      <PageTitle screenName={t.screenName} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {t.screenName}
      </h1>

      <BannerSlot
        polite={alertFailure ? null : failureNode}
        alert={alertFailure ? failureNode : null}
        announcement={starting !== null ? <p>{t.starting}</p> : null}
      />

      {state.status === "loading" ? (
        <div aria-busy="true" className="mt-q24">
          <p role="status" className="sr-only">
            {messages.server.busy}
          </p>
          {showSkeleton ? (
            <div aria-hidden="true" className="flex flex-col gap-q24">
              <SkeletonBlock className="h-q24 w-3/5" />
              <div className="flex flex-col gap-q8">
                {GAMES.map((game) => (
                  <SkeletonBlock key={game.kind} className="h-22 w-full" />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {ready !== null ? (
        <div className="mt-q24 flex flex-col gap-q24">
          {plan !== null && !unavailable ? (
            <p className="text-small text-ink-secondary">{renderTemplate(t.planLine, { title: <bdi dir="auto">{locale === "ar" ? plan.titleAr : plan.titleEn}</bdi> })}</p>
          ) : null}
          <Notice>{t.notice}</Notice>
          {plan === null ? <NoPlan t={t} /> : null}
          {showRows && plan !== null ? (
            <ul className="divide-y divide-divider overflow-hidden rounded-md border border-divider bg-surface">
              {GAMES.map((game) => (
                <GameRow
                  key={game.kind}
                  game={game}
                  t={t}
                  loading={starting === game.kind}
                  inert={starting !== null}
                  onPress={() => void start(game, plan, ready.editions)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// c8 (G-24): the tab stays open without a plan, and the only way on is the start of one (S-08).
function NoPlan({ t }: { t: GamesMessages }) {
  return (
    <div role="status" className="flex flex-col items-start gap-q16 rounded-md border border-divider bg-surface p-q16">
      <Icon name="info" size="lg" className="text-info-edge" />
      <p className="text-section text-ink">{t.empty.title}</p>
      <p className="text-body-compact text-ink-secondary">{t.empty.text}</p>
      <LinkButton href="/start">{t.empty.action}</LinkButton>
    </div>
  );
}

// A game row (UI-screens S-14 "Rows"): a button whose name is the game name and whose description is the sentence under it, so the visible name is
// contained in the accessible name (2.5.3). The pressed row shows a spinner at the start edge and `aria-busy`; every row is inert while one starts,
// by `aria-disabled`, so the row keeps its focus. The icon is supplemental and the chevron points to the end edge in both directions.
function GameRow({ game, t, loading, inert, onPress }: { game: GameEntry; t: GamesMessages; loading: boolean; inert: boolean; onPress: () => void }) {
  const nameId = useId();
  const descriptionId = useId();
  const copy = t.games[game.kind];
  return (
    <li>
      <button
        type="button"
        data-game={game.kind}
        aria-labelledby={nameId}
        aria-describedby={descriptionId}
        aria-busy={loading || undefined}
        aria-disabled={inert || undefined}
        onClick={() => {
          if (!inert) onPress();
        }}
        className="flex min-h-22 w-full items-center gap-q12 px-q16 py-q12 text-start transition-[background-color] duration-(--q-duration-fast) hover:bg-selection focus-visible:outline-offset-[-2px] aria-disabled:cursor-default aria-disabled:hover:bg-surface"
      >
        <span aria-hidden="true" className="flex size-target shrink-0 items-center justify-center rounded-sm bg-selection text-ink-accent">
          {loading ? <Spinner /> : <Icon name={game.icon} size="lg" />}
        </span>
        <span className="min-w-0 flex-1">
          <span id={nameId} className="block text-body font-semibold text-ink">
            {copy.name}
          </span>
          <span id={descriptionId} className="block text-small text-ink-secondary">
            {copy.description}
          </span>
        </span>
        <span aria-hidden="true" className="flex shrink-0 rotate-180 text-ink-secondary">
          <Icon name="back" size="md" />
        </span>
      </button>
    </li>
  );
}
