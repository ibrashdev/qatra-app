"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { READ_RETRY_POLICY } from "@/lib/api/client";
import { useApiRuntime } from "@/lib/api/react";
import type { PlanChat, PlanChatTurnRequest, PlanProposal, QuickReply, Today } from "@/lib/api/types";
import { raisePlanConfirmed } from "./confirmed-flash";
import { classifyChatError, type ChatFailure } from "./failure";
import { confirmState, turnWasRecorded, type ConfirmState } from "./rules";
import { redirectToLogin } from "./session-ended";
import type { OutgoingTurn } from "./ChatThread";

// An id that cannot be a conversation id never reaches the API (the client refuses odd paths), so it is the not-found state at once.
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LoadState = { phase: "loading" } | { phase: "ready" } | { phase: "not_found" } | { phase: "failed"; failure: ChatFailure };

// What Slot T shows besides the connectivity banners, which the view derives itself.
export type ChatNotice =
  | { kind: "stale" | "plan_moved" | "race" | "not_active" | "not_active_completed" | "unavailable" | "origin" | "internal" }
  | { kind: "throttled"; retryAfterSec: number };

export type PlanChatDialog = "replace" | "revise" | null;

interface Outgoing extends OutgoingTurn {
  request: PlanChatTurnRequest;
  shownCount: number; // messages the thread held when it was sent: E33 shows after a lost answer whether the server recorded it (P-14)
  via: "text" | "quick";
}

// The state machine of S-34: E33 on load (with E11 and E18 for the demo flag and the plan in force), E32 per turn, E34 to confirm. Nothing here
// retries on its own: E32 and E34 create rows (P-14), so a retry runs E33 first and resends only what the server did not record.
export function usePlanChat(chatId: string) {
  const router = useRouter();
  const { api } = useApiRuntime();
  const { locale } = useLocale();

  const [load, setLoad] = useState<LoadState>(() => (CHAT_ID.test(chatId) ? { phase: "loading" } : { phase: "not_found" }));
  const [chat, setChat] = useState<PlanChat | null>(null);
  const [proposals, setProposals] = useState<ReadonlyMap<number, PlanProposal>>(() => new Map());
  const [isDemo, setIsDemo] = useState(false);
  const [today, setToday] = useState<Today | null>(null);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [notice, setNotice] = useState<ChatNotice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [dialog, setDialog] = useState<PlanChatDialog>(null);
  const [locked, setLocked] = useState(false);
  // Counters the view watches to move focus: after a reply (and how it was asked) and after a stale proposal was replaced.
  const [reply, setReply] = useState<{ n: number; via: "text" | "quick" } | null>(null);
  const [staleReplaced, setStaleReplaced] = useState(0);
  const uncertainConfirm = useRef(false);

  const adopt = useCallback((next: PlanChat) => {
    setChat(next);
    const proposal = next.proposal;
    if (proposal !== null) setProposals((previous) => (previous.has(proposal.proposalVersion) ? previous : new Map(previous).set(proposal.proposalVersion, proposal)));
  }, []);

  const showFailure = useCallback(
    (failure: ChatFailure) => {
      switch (failure.kind) {
        case "session_ended":
          redirectToLogin(router, `/plan/chat/${chatId}`);
          break;
        case "not_found":
          setLoad({ phase: "not_found" });
          break;
        case "throttled":
          setNotice({ kind: "throttled", retryAfterSec: failure.retryAfterSec });
          break;
        case "unavailable":
        case "origin":
        case "internal":
          setNotice({ kind: failure.kind });
          break;
        case "validation":
          setNotice({ kind: "internal" });
          break;
        default:
          // connectivity: the offline and wake-up banners speak; aborted: nothing to say.
          break;
      }
    },
    [chatId, router],
  );

  const loadAll = useCallback(
    async (signal?: AbortSignal) => {
      if (!CHAT_ID.test(chatId) || signal?.aborted) return;
      const options = { signal, retry: READ_RETRY_POLICY };
      try {
        const [next, profile, day] = await Promise.all([api.planChat(chatId, options), api.me(options), api.today(options)]);
        if (signal?.aborted) return;
        adopt(next);
        setIsDemo(profile.isDemo);
        setToday(day);
        setLoad({ phase: "ready" });
      } catch (error) {
        if (signal?.aborted) return;
        const failure = classifyChatError(error);
        if (failure.kind === "aborted") return;
        if (failure.kind === "session_ended") redirectToLogin(router, `/plan/chat/${chatId}`);
        else setLoad(failure.kind === "not_found" ? { phase: "not_found" } : { phase: "failed", failure });
      }
    },
    [adopt, api, chatId, router],
  );

  useEffect(() => {
    const controller = new AbortController();
    // Deferred one microtask: the first state change belongs after the answer, never inside the effect body.
    queueMicrotask(() => void loadAll(controller.signal));
    return () => controller.abort();
  }, [loadAll]);

  const retryLoad = useCallback(() => {
    setLoad({ phase: "loading" });
    void loadAll();
  }, [loadAll]);

  const refreshChat = useCallback(async (): Promise<PlanChat | null> => {
    try {
      const next = await api.planChat(chatId);
      adopt(next);
      return next;
    } catch (error) {
      showFailure(classifyChatError(error));
      return null;
    }
  }, [adopt, api, chatId, showFailure]);

  // A conversation that the server closed (G-38): the thread turns read-only. If E33 cannot say more, it is shown as closed.
  const closeLocally = useCallback(async () => {
    const next = await refreshChat();
    if (next === null) setChat((current) => (current === null || current.status !== "open" ? current : { ...current, status: "abandoned" }));
  }, [refreshChat]);

  const submitTurn = useCallback(
    async (turn: Outgoing) => {
      try {
        const next = await api.sendPlanChatTurn(chatId, turn.request);
        adopt(next);
        setOutgoing(null);
        setReply((previous) => ({ n: (previous?.n ?? 0) + 1, via: turn.via }));
      } catch (error) {
        const failure = classifyChatError(error);
        if (failure.kind === "chat_closed") {
          setOutgoing(null);
          await closeLocally();
        } else if (failure.kind === "not_found" || failure.kind === "session_ended") {
          setOutgoing(null);
          showFailure(failure);
        } else {
          setOutgoing({ ...turn, status: "failed" });
          showFailure(failure);
        }
      }
    },
    [adopt, api, chatId, closeLocally, showFailure],
  );

  const start = useCallback(
    (shown: string, request: PlanChatTurnRequest, via: "text" | "quick") => {
      if (chat === null || outgoing !== null) return;
      setNotice(null);
      const turn: Outgoing = { text: shown, status: "sending", request, shownCount: chat.messages.length, via };
      setOutgoing(turn);
      void submitTurn(turn);
    },
    [chat, outgoing, submitTurn],
  );

  const send = useCallback((text: string) => start(text, { text }, "text"), [start]);

  const retryTurn = useCallback(async () => {
    if (outgoing === null || outgoing.status !== "failed") return;
    const turn: Outgoing = { ...outgoing, status: "sending" };
    setNotice(null);
    setOutgoing(turn);
    try {
      const fresh = await api.planChat(chatId);
      adopt(fresh);
      if (turnWasRecorded(fresh, turn.shownCount, turn.request.text === undefined ? {} : { text: turn.request.text })) {
        setOutgoing(null);
        setReply((previous) => ({ n: (previous?.n ?? 0) + 1, via: turn.via }));
        return;
      }
    } catch (error) {
      const failure = classifyChatError(error);
      setOutgoing({ ...turn, status: "failed" });
      showFailure(failure);
      return;
    }
    await submitTurn(turn);
  }, [adopt, api, chatId, outgoing, showFailure, submitTurn]);

  const confirmation: ConfirmState | null =
    chat === null
      ? null
      : confirmState({ chat, replying: outgoing?.status === "sending", confirming, locked, plan: today?.plan ?? null });

  const finish = useCallback(
    (planId: string | null) => {
      raisePlanConfirmed(planId === null ? "created" : "revised");
      router.replace("/today");
    },
    [router],
  );

  const confirmNow = useCallback(async () => {
    if (chat === null || chat.proposal === null || confirming) return;
    const shownVersion = chat.proposal.proposalVersion;
    setDialog(null);
    setNotice(null);
    setConfirming(true);
    let leaving = false;
    try {
      // P-14: after a lost answer E33 says whether the plan was saved. A proposal that moved meanwhile has not been seen, so it is not confirmed.
      if (uncertainConfirm.current) {
        uncertainConfirm.current = false;
        const fresh = await api.planChat(chatId);
        adopt(fresh);
        if (fresh.status === "confirmed") {
          leaving = true;
          finish(chat.planId);
          return;
        }
        if (fresh.proposal === null || fresh.proposal.proposalVersion !== shownVersion) {
          setNotice({ kind: "stale" });
          setStaleReplaced((n) => n + 1);
          return;
        }
      }
      await api.confirmPlanChat(chatId, { proposalVersion: shownVersion });
      leaving = true;
      finish(chat.planId);
    } catch (error) {
      const failure = classifyChatError(error);
      switch (failure.kind) {
        case "connectivity":
          uncertainConfirm.current = true;
          break;
        case "proposal_stale":
          setNotice({ kind: "stale" });
          if ((await refreshChat()) !== null) setStaleReplaced((n) => n + 1);
          break;
        case "plan_version":
          setNotice({ kind: "plan_moved" });
          break;
        case "active_plan_conflict":
          setNotice({ kind: "race" });
          break;
        case "plan_not_active":
          setNotice({ kind: today?.plan?.planId === chat.planId && today?.plan?.status === "completed" ? "not_active_completed" : "not_active" });
          setLocked(true);
          break;
        case "chat_closed":
          await closeLocally();
          break;
        default:
          showFailure(failure);
      }
    } finally {
      // On success the button keeps its loading state while S-11 opens.
      if (!leaving) setConfirming(false);
    }
  }, [adopt, api, chat, chatId, closeLocally, confirming, finish, refreshChat, showFailure, today]);

  // A creation while E18 shows an active plan, and every revision, ask first (P-12); a first plan opens no dialog.
  const requestConfirm = useCallback(() => {
    if (chat === null || confirmation === null || !confirmation.enabled) return;
    if (chat.planId !== null) setDialog("revise");
    else if (today?.plan?.status === "active") setDialog("replace");
    else void confirmNow();
  }, [chat, confirmation, confirmNow, today]);

  const pickQuickReply = useCallback(
    (quick: QuickReply) => {
      if (quick.code === "confirm") {
        requestConfirm(); // the same action as the button, never E32
        return;
      }
      start(locale === "ar" ? quick.labelAr : quick.labelEn, { quickReply: quick.code }, "quick");
    },
    [locale, requestConfirm, start],
  );

  // G-13, the refresh action: read E18 and E33 again, then ask the dialog again.
  const refreshPage = useCallback(async () => {
    setNotice(null);
    try {
      const [next, day] = await Promise.all([api.planChat(chatId), api.today()]);
      adopt(next);
      setToday(day);
      if (next.status === "open" && next.planId === null && day.plan?.status === "active") setDialog("replace");
    } catch (error) {
      showFailure(classifyChatError(error));
    }
  }, [adopt, api, chatId, showFailure]);

  // G-09, the start-over action: a new revision conversation on the current version is S-13's entry (E31 with the plan id).
  const startOver = useCallback(() => router.replace("/plan/revise"), [router]);

  return {
    load,
    chat,
    proposals,
    isDemo,
    today,
    outgoing,
    notice,
    confirming,
    dialog,
    locked,
    reply,
    staleReplaced,
    confirmation,
    send,
    pickQuickReply,
    retryTurn,
    requestConfirm,
    confirmNow,
    closeDialog: () => setDialog(null),
    refreshPage,
    startOver,
    retryLoad,
  };
}
