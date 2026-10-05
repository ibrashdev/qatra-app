"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FocusShell } from "@/components/ui/FocusShell";
import { SkeletonBlock } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { useLocale } from "@/i18n/LocaleProvider";
import { renderTemplate } from "@/i18n/template";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import { useWakeUpState } from "@/lib/api/react";
import { useAfterDelay } from "@/lib/dom/use-after-delay";
import { useConnectivity } from "@/lib/net/use-connectivity";
import { LoadFailureBanner, NoticeBanner } from "./ChatBanners";
import { ChatThread, CURRENT_CARD_ID } from "./ChatThread";
import { Composer } from "./Composer";
import { QuickReplies } from "./QuickReplies";
import { capsReached } from "./rules";
import { usePlanChat } from "./use-plan-chat";

const SKELETON_DELAY_MS = 300; // UI-tokens 6.14

// S-34 (UI-screens Batch 2): the plan review with the assistant at /plan/chat/[chatId]. The thread, the six-section plan card, the shortcuts,
// the sticky dock with «اعتماد الخطة» and the composer. Nothing is saved before the confirmation (R02, D34).
export function PlanChatScreen({ chatId }: { chatId: string }) {
  const router = useRouter();
  const { locale, messages } = useLocale();
  const text = planChatMessages(locale);
  const state = usePlanChat(chatId);
  const { online } = useConnectivity();
  const wake = useWakeUpState();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const showSkeleton = useAfterDelay(SKELETON_DELAY_MS);
  const seenVersion = useRef<number | null>(null);

  const { chat, load, confirmation } = state;
  const ready = load.phase === "ready" && chat !== null;
  const revision = chat !== null && chat.planId !== null;
  const version = chat?.proposal?.proposalVersion ?? null;
  const replying = state.outgoing?.status === "sending";
  const offline = !online;
  const waking = !offline && (wake.phase === "waking" || wake.phase === "timed_out");

  // After E33 focus goes to the heading, unless the learner already put it somewhere.
  useEffect(() => {
    if (!ready) return;
    const active = document.activeElement;
    if (active === null || active === document.body) document.querySelector<HTMLElement>("[data-page-heading]")?.focus({ preventScroll: true });
  }, [ready]);

  // After a reply: the text area keeps focus when the learner typed; a chip moves it to the new assistant message.
  useEffect(() => {
    if (state.reply === null) return;
    if (state.reply.via === "text") {
      textareaRef.current?.focus({ preventScroll: true });
      return;
    }
    const messagesInThread = document.querySelectorAll<HTMLElement>("[data-message-id][role='group']");
    messagesInThread[messagesInThread.length - 1]?.focus();
  }, [state.reply]);

  // A new proposal puts the top of its card under the bar, instantly (never smooth).
  useEffect(() => {
    if (version === null) return;
    const previous = seenVersion.current;
    seenVersion.current = version;
    if (previous === null || previous === version) return;
    document.getElementById(CURRENT_CARD_ID)?.scrollIntoView?.({ block: "start", behavior: "instant" });
  }, [version]);

  // G-37: the replaced card takes focus at its chip row.
  useEffect(() => {
    if (state.staleReplaced === 0) return;
    document.querySelector<HTMLElement>("[data-current-card] [data-card-chip]")?.focus();
  }, [state.staleReplaced]);

  const closedKind = load.phase === "not_found" ? "notFound" : chat === null || chat.status === "open" ? null : chat.status === "confirmed" ? "confirmed" : "closed";
  const open = ready && chat.status === "open";

  const planTitle = state.today?.plan === null || state.today?.plan === undefined ? "" : locale === "ar" ? state.today.plan.titleAr : state.today.plan.titleEn;
  const pausedRevision = revision && state.today?.plan?.planId === chat?.planId && state.today?.plan?.status === "paused";
  const dialogKind = state.dialog ?? "replace";

  // The wake-up message belongs to the shell's own status area, so Slot T carries the offline banner and the screen's notices only.
  const slot = offline ? (
    <Banner variant="info">{messages.form.offline}</Banner>
  ) : state.notice !== null ? (
    <NoticeBanner notice={state.notice} onStartOver={state.startOver} onRefresh={() => void state.refreshPage()} />
  ) : chat !== null && open && capsReached(chat) ? (
    <Banner variant="info">{text.banners.caps}</Banner>
  ) : null;

  const closedAction =
    closedKind === "confirmed"
      ? { label: text.closed.openToday, to: "/today" }
      : closedKind === "closed" && revision
        ? { label: text.closed.backToPlan, to: "/plan" }
        : { label: text.closed.startOver, to: "/start" };

  const describedBy = [chat?.proposal ? CURRENT_CARD_ID : null, confirmation?.hint ? hintId : null].filter(Boolean).join(" ");

  const dock =
    open && confirmation !== null ? (
      <div className="mx-auto w-full max-w-column">
        <Button
          fullWidth
          loading={state.confirming}
          aria-disabled={!confirmation.enabled || undefined}
          aria-describedby={describedBy || undefined}
          onClick={state.requestConfirm}
        >
          {state.confirming ? text.confirm.confirming : text.confirm.button}
        </Button>
        {confirmation.hint !== null ? (
          <p id={hintId} className="mt-q8 text-small text-ink-secondary">
            {confirmation.hint === "no_proposal" ? text.confirm.hintNoProposal : text.confirm.hintUnchanged}
          </p>
        ) : null}
        <div className="mt-q12">
          <Composer
            isDemo={state.isDemo}
            replying={state.outgoing !== null}
            locked={state.locked || state.confirming}
            lastReply={chat.modelTurnsLeft === 1}
            onSend={state.send}
            textareaRef={textareaRef}
          />
        </div>
        <p role="status" className="sr-only">
          {state.confirming ? text.confirm.confirming : null}
        </p>
      </div>
    ) : undefined;

  return (
    <FocusShell
      title={text.title}
      back={{ destination: revision ? text.backRevision : text.backNew, href: revision ? "/plan/revise" : "/start" }}
      actionBar={dock}
    >
      {/* Slot T: at most one banner, under the bar. The polite region stays in the page while empty, so a banner added later is announced. */}
      <div
        role="status"
        aria-live="polite"
        className="sticky top-[calc(var(--q-size-appbar)+env(safe-area-inset-top))] z-(--q-z-sticky) bg-page has-[*]:pb-q16"
      >
        {load.phase === "failed" ? (
          <LoadFailureBanner failure={load.failure} offline={offline} waking={waking} />
        ) : (
          slot
        )}
      </div>

      {load.phase === "loading" ? (
        <div aria-busy="true">
          <p role="status" className="sr-only">
            {messages.server.busy}
          </p>
          {showSkeleton ? (
            <div className="flex flex-col gap-q16">
              <SkeletonBlock className="h-q48 w-4/5" />
              <SkeletonBlock className="h-q48 w-3/5 self-end" />
              <SkeletonBlock className="h-40 w-full" />
            </div>
          ) : null}
        </div>
      ) : null}

      {load.phase === "failed" ? (
        <div className="mt-q16">
          <Button variant="secondary" onClick={state.retryLoad}>
            {messages.error.retry}
          </Button>
        </div>
      ) : null}

      {closedKind !== null ? (
        <div role="status" className="mb-q16 rounded-md border border-divider bg-surface p-q16">
          <p className="text-body text-ink">{closedKind === "notFound" ? text.closed.notFound : closedKind === "confirmed" ? text.closed.confirmed : text.closed.closed}</p>
          <div className="mt-q16">
            <Button variant="secondary" onClick={() => router.push(closedAction.to)}>
              {closedAction.label}
            </Button>
          </div>
        </div>
      ) : null}

      {ready && load.phase === "ready" ? (
        <div className="flex flex-col gap-q16">
          <ChatThread chat={chat} proposals={state.proposals} outgoing={state.outgoing} onRetry={() => void state.retryTurn()} revision={revision} />
          {/* A polite status of its own, apart from the log: static, never a typing animation. */}
          <div role="status" aria-live="polite">
            {replying ? (
              <p className="flex items-center gap-q8 text-small text-ink-secondary">
                <Spinner />
                {text.replying}
              </p>
            ) : null}
          </div>
          {open ? <QuickReplies replies={chat.quickReplies} disabled={state.outgoing !== null || state.locked || state.confirming} onPick={state.pickQuickReply} /> : null}
        </div>
      ) : null}

      <Dialog
        open={state.dialog !== null}
        title={dialogKind === "replace" ? text.dialogs.replaceTitle : text.dialogs.reviseTitle}
        primary={{ label: text.dialogs.cancel, onPress: state.closeDialog }}
        secondary={{ label: dialogKind === "replace" ? text.dialogs.replaceConfirm : text.dialogs.reviseConfirm, onPress: () => void state.confirmNow() }}
        onCancel={state.closeDialog}
      >
        {dialogKind === "replace"
          ? renderTemplate(text.dialogs.replaceBody, { title: <bdi lang={locale}>{planTitle}</bdi> })
          : `${text.dialogs.reviseBody}${pausedRevision ? ` ${text.dialogs.revisePaused}` : ""}`}
      </Dialog>
    </FocusShell>
  );
}
