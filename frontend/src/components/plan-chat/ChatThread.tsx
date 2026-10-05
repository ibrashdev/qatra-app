"use client";

import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { TextLink } from "@/components/ui/TextLink";
import { cx } from "@/lib/cx";
import { useLocale } from "@/i18n/LocaleProvider";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import type { ChatMessage, PlanChat, PlanProposal } from "@/lib/api/types";
import { PlanCard } from "./PlanCard";
import { firstFallbackId, proposalVersions } from "./rules";

// A message the learner sent that the thread does not hold yet (sending) or that failed (P-14: it stays, with its text, until retried).
export interface OutgoingTurn {
  text: string;
  status: "sending" | "failed";
}

export const CURRENT_CARD_ID = "plan-chat-current-card";

function Author({ name }: { name: string }) {
  return <p className="mb-q4 text-caption text-ink-secondary">{name}</p>;
}

// Learner at the end edge, assistant at the start edge (logical, so the thread mirrors in LTR); at most 85 % wide, 80 % from 768 px.
function Bubble({ learner, children }: { learner: boolean; children: ReactNode }) {
  return (
    <div
      className={cx(
        "max-w-[85%] rounded-md px-q16 py-q12 text-body-compact text-ink tablet:max-w-[80%]",
        learner ? "self-end bg-selection" : "self-start border border-divider bg-surface",
      )}
    >
      {children}
    </div>
  );
}

// UI-screens S-34 c3 to c11: the thread as a polite log of additions with the transparency notice as its first item. The server's texts are
// shown as received; the refusal, the redirect and the first fallback notice carry the info icon. An earlier proposal card is shown only when
// this session saw it (the messages carry no proposal of their own).
export function ChatThread({
  chat,
  proposals,
  outgoing,
  onRetry,
  revision,
}: {
  chat: PlanChat;
  proposals: ReadonlyMap<number, PlanProposal>;
  outgoing: OutgoingTurn | null;
  onRetry: () => void;
  revision: boolean;
}) {
  const { locale } = useLocale();
  const text = planChatMessages(locale);
  const proposal = chat.proposal;
  const versions = proposalVersions(chat.messages, proposal?.proposalVersion ?? 0);
  const noticeId = firstFallbackId(chat.messages);

  function renderMessage(message: ChatMessage) {
    if (message.role === "learner") {
      return (
        <div key={message.messageId} data-message-id={message.messageId} className="flex flex-col">
          <Bubble learner>
            <Author name={text.thread.you} />
            <p dir="auto" lang={chat.language}>
              {message.text}
            </p>
          </Bubble>
        </div>
      );
    }
    const fixedNotice = message.kind === "refusal" || message.kind === "redirect" || (message.kind === "fallback" && message.messageId === noticeId);
    const version = versions.get(message.messageId);
    const card = version === undefined || proposal === null ? null : version === proposal.proposalVersion ? proposal : (proposals.get(version) ?? null);
    return (
      <div key={message.messageId} data-message-id={message.messageId} role="group" aria-label={text.thread.assistantReply} tabIndex={-1} className="flex flex-col gap-q8">
        <Bubble learner={false}>
          <Author name={text.thread.assistant} />
          <p dir="auto" lang={chat.language} className={cx(fixedNotice && "flex items-start gap-q8")}>
            {fixedNotice ? <Icon name="info" size="sm" className="mt-1 text-info-edge" /> : null}
            <span>{message.text}</span>
          </p>
        </Bubble>
        {card !== null ? <PlanCard proposal={card} current={version === proposal?.proposalVersion} domId={version === proposal?.proposalVersion ? CURRENT_CARD_ID : undefined} /> : null}
        {message.kind === "fallback" && message.messageId === noticeId && revision ? (
          <div>
            <TextLink href="/plan/revise">{text.fallbackModel}</TextLink>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div role="log" aria-relevant="additions" aria-label={text.thread.label} className="flex flex-col gap-q16">
      <Notice>{text.transparency}</Notice>
      {chat.messages.map(renderMessage)}
      {outgoing === null ? null : (
        <div className="flex flex-col" data-outgoing={outgoing.status}>
          <Bubble learner>
            <Author name={text.thread.you} />
            <p dir="auto" lang={chat.language}>
              {outgoing.text}
            </p>
          </Bubble>
          {outgoing.status === "failed" ? (
            <div className="mt-q8 flex flex-wrap items-center gap-x-q12 self-end">
              <p role="alert" className="flex items-start gap-q8 text-small text-error-ink">
                <Icon name="error" size="sm" className="mt-1" />
                {text.sendFailed.line}
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex min-h-target items-center rounded-sm text-body-compact text-link underline underline-offset-4"
              >
                {text.sendFailed.retry}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
