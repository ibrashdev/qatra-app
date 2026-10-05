import type { ChatMessage, Plan, PlanChat, PlanProposal } from "@/lib/api/types";

// The screen never computes a plan number: these rules read fields the server sent and decide what may be pressed or shown.

export const MESSAGE_LIMIT = 500;

// UI-screens S-34 composer: plain text, trimmed, counted in code points (an emoji or a letter with a mark is one, not two).
export function messageLength(text: string): number {
  return Array.from(text.trim()).length;
}

export type SendBlock = "empty" | "too_long" | "pending" | "demo" | "locked";

// Sending is blocked (the button stays focusable, aria-disabled) when the text is empty or over the limit, a reply is pending, or the account is a demo.
export function sendBlock(text: string, state: { replying: boolean; isDemo: boolean; locked: boolean }): SendBlock | null {
  if (state.isDemo) return "demo";
  if (state.locked) return "locked";
  if (state.replying) return "pending";
  const length = messageLength(text);
  if (length === 0) return "empty";
  return length > MESSAGE_LIMIT ? "too_long" : null;
}

export type ConfirmHint = "no_proposal" | "unchanged" | null;

export interface ConfirmState {
  enabled: boolean;
  hint: ConfirmHint;
}

const sameSet = <T extends string | number>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

// A revision conversation starts from the plan in force, so a proposal that equals it changes nothing and E34 would answer `no_fields` (O-23).
export function proposalDiffersFromPlan(proposal: PlanProposal, plan: Plan): boolean {
  return (
    proposal.sessionMinutes !== plan.sessionMinutes ||
    proposal.order !== plan.order ||
    proposal.preferredDate !== plan.preferredDate ||
    !sameSet(proposal.paths, plan.paths) ||
    !sameSet(proposal.targetScope.sectionOrdinals, plan.targetScope.sectionOrdinals)
  );
}

// Enabled only with a proposal, an open conversation, no reply pending and no confirmation running; for a revision also only when the proposal
// differs from the plan in force. Without that plan in hand (a paused plan is not E18's) the server's no_fields check is the arbiter.
export function confirmState(input: { chat: PlanChat; replying: boolean; confirming: boolean; locked: boolean; plan: Plan | null }): ConfirmState {
  const { chat, plan } = input;
  if (chat.proposal === null) return { enabled: false, hint: "no_proposal" };
  if (chat.status !== "open" || input.replying || input.confirming || input.locked) return { enabled: false, hint: null };
  if (chat.planId !== null && plan !== null && plan.planId === chat.planId && !proposalDiffersFromPlan(chat.proposal, plan)) return { enabled: false, hint: "unchanged" };
  return { enabled: true, hint: null };
}

// The server numbers a proposal 1, 2, 3 and sends one `proposal` message per version, so the last proposal message belongs to the current
// version and each earlier one to the version below it. The messages carry no proposal of their own.
export function proposalVersions(messages: readonly ChatMessage[], currentVersion: number): ReadonlyMap<string, number> {
  const versions = new Map<string, number>();
  let version = currentVersion;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind !== "proposal") continue;
    versions.set(message.messageId, version);
    version -= 1;
  }
  return versions;
}

// The unavailable notice shows once per conversation (G-35): the first fallback message is the notice, any later one is an ordinary reply.
export function firstFallbackId(messages: readonly ChatMessage[]): string | null {
  return messages.find((message) => message.kind === "fallback")?.messageId ?? null;
}

// Reaching the per-conversation cap is not an error: the server answers with a fallback reply, and the banner explains why (S-34 "Caps reached").
export function capsReached(chat: PlanChat): boolean {
  return chat.modelTurnsLeft === 0 && chat.messages.some((message) => message.kind === "fallback");
}

export function lastAssistantMessageId(messages: readonly ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") return messages[index]?.messageId ?? null;
  }
  return null;
}

// P-14 for E32: after a lost answer E33 says whether the server recorded the message. The only learner message after the ones already shown is ours.
export function turnWasRecorded(fresh: PlanChat, shownCount: number, sent: { text?: string }): boolean {
  return fresh.messages.some((message) => message.role === "learner" && message.ordinal > shownCount && (sent.text === undefined ? message.kind === "quick_reply" : message.text === sent.text));
}
