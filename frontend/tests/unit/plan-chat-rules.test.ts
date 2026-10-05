import { describe, expect, it } from "vitest";
import { classifyChatError } from "@/components/plan-chat/failure";
import {
  capsReached,
  confirmState,
  firstFallbackId,
  MESSAGE_LIMIT,
  messageLength,
  proposalDiffersFromPlan,
  proposalVersions,
  sendBlock,
  turnWasRecorded,
} from "@/components/plan-chat/rules";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { mockToday } from "@/lib/api/mock";
import type { ChatMessage, Plan, PlanChat, PlanProposal } from "@/lib/api/types";

const plan = mockToday.plan as Plan;

const proposal: PlanProposal = {
  proposalVersion: 2,
  editionId: plan.editionId,
  targetScope: plan.targetScope,
  paths: plan.paths,
  order: plan.order,
  sessionMinutes: plan.sessionMinutes,
  preferredDate: plan.preferredDate,
  estimate: plan.agreedEstimate,
  sections: { goal: "g", totalTime: "t", dailyTime: "d", stages: "s", reviews: "r", nextStep: "n" },
};

let counter = 0;
const message = (over: Partial<ChatMessage>): ChatMessage => ({
  messageId: `77777777-7777-4777-8777-${String((counter += 1)).padStart(12, "0")}`,
  ordinal: counter,
  role: "assistant",
  kind: "text",
  text: "t",
  source: "rules",
  createdAt: "2026-10-05T09:00:00Z",
  ...over,
});

const chatOf = (over: Partial<PlanChat> = {}): PlanChat => ({
  chatId: "66666666-6666-4666-8666-000000000001",
  status: "open",
  planId: null,
  language: "en",
  messages: [message({ kind: "proposal" })],
  proposal,
  quickReplies: [],
  modelTurnsLeft: 6,
  assistant: { source: "rules" },
  ...over,
});

describe("composer limit (UI-screens S-34 composer)", () => {
  it("counts the trimmed text in code points", () => {
    expect(messageLength("  abc  ")).toBe(3);
    expect(messageLength("\u{1F4A7}\u{1F4A7}")).toBe(2);
    expect(messageLength("")).toBe(0);
    expect(MESSAGE_LIMIT).toBe(500);
  });

  const open = { replying: false, isDemo: false, locked: false };

  it("allows exactly 500 and blocks 501, and blocks empty or blank text", () => {
    expect(sendBlock("a".repeat(500), open)).toBeNull();
    expect(sendBlock("a".repeat(501), open)).toBe("too_long");
    expect(sendBlock("   ", open)).toBe("empty");
    expect(sendBlock("", open)).toBe("empty");
    expect(sendBlock(`  ${"a".repeat(500)}  `, open)).toBeNull();
  });

  it("blocks while a reply is pending, in a demo account and when locked, whatever the text", () => {
    expect(sendBlock("hello", { ...open, replying: true })).toBe("pending");
    expect(sendBlock("hello", { ...open, isDemo: true })).toBe("demo");
    expect(sendBlock("hello", { ...open, locked: true })).toBe("locked");
  });
});

describe("confirm rules (UI-screens S-34 Confirm)", () => {
  const base = { replying: false, confirming: false, locked: false, plan: null };

  it("is enabled with a proposal and an open conversation", () => {
    expect(confirmState({ ...base, chat: chatOf() })).toEqual({ enabled: true, hint: null });
  });

  it("is disabled without a proposal, with the hint to ask first", () => {
    expect(confirmState({ ...base, chat: chatOf({ proposal: null }) })).toEqual({ enabled: false, hint: "no_proposal" });
  });

  it("is disabled once the conversation is not open, while a reply is pending, while confirming and when locked, with no hint", () => {
    for (const status of ["confirmed", "abandoned"] as const) expect(confirmState({ ...base, chat: chatOf({ status }) })).toEqual({ enabled: false, hint: null });
    expect(confirmState({ ...base, chat: chatOf(), replying: true })).toEqual({ enabled: false, hint: null });
    expect(confirmState({ ...base, chat: chatOf(), confirming: true })).toEqual({ enabled: false, hint: null });
    expect(confirmState({ ...base, chat: chatOf(), locked: true })).toEqual({ enabled: false, hint: null });
  });

  it("for a revision is disabled until the proposal differs from the plan in force", () => {
    const revision = chatOf({ planId: plan.planId });
    expect(confirmState({ ...base, chat: revision, plan })).toEqual({ enabled: false, hint: "unchanged" });
    const changed = chatOf({ planId: plan.planId, proposal: { ...proposal, sessionMinutes: 15 } });
    expect(confirmState({ ...base, chat: changed, plan })).toEqual({ enabled: true, hint: null });
  });

  it("does not hold a revision back when the plan in hand is another one or missing", () => {
    const revision = chatOf({ planId: plan.planId });
    expect(confirmState({ ...base, chat: revision, plan: null }).enabled).toBe(true);
    expect(confirmState({ ...base, chat: revision, plan: { ...plan, planId: "44444444-4444-4444-8444-0000000000ff" } }).enabled).toBe(true);
  });

  it("compares minutes, order, date, paths and scope, and ignores the order of a list", () => {
    expect(proposalDiffersFromPlan(proposal, plan)).toBe(false);
    expect(proposalDiffersFromPlan({ ...proposal, sessionMinutes: 5 }, plan)).toBe(true);
    expect(proposalDiffersFromPlan({ ...proposal, order: "reverse" }, plan)).toBe(true);
    expect(proposalDiffersFromPlan({ ...proposal, preferredDate: null }, plan)).toBe(true);
    expect(proposalDiffersFromPlan({ ...proposal, paths: ["matn"] }, plan)).toBe(true);
    expect(proposalDiffersFromPlan({ ...proposal, targetScope: { sectionOrdinals: [2, 1] } }, plan)).toBe(false);
    expect(proposalDiffersFromPlan({ ...proposal, targetScope: { sectionOrdinals: [1] } }, plan)).toBe(true);
  });
});

describe("thread rules", () => {
  it("numbers the proposal messages from the current version backwards", () => {
    const first = message({ kind: "proposal" });
    const reply = message({ kind: "text" });
    const second = message({ kind: "proposal" });
    const third = message({ kind: "proposal" });
    const versions = proposalVersions([first, reply, second, third], 3);
    expect([versions.get(first.messageId), versions.get(reply.messageId), versions.get(second.messageId), versions.get(third.messageId)]).toEqual([1, undefined, 2, 3]);
  });

  it("shows the unavailable notice for the first fallback message only", () => {
    const first = message({ kind: "fallback" });
    const second = message({ kind: "fallback" });
    expect(firstFallbackId([message({ kind: "text" }), first, second])).toBe(first.messageId);
    expect(firstFallbackId([message({ kind: "text" })])).toBeNull();
  });

  it("raises the cap banner only when no model turns are left and the server answered with a fallback", () => {
    const fallback = message({ kind: "fallback" });
    expect(capsReached(chatOf({ modelTurnsLeft: 0, messages: [fallback] }))).toBe(true);
    expect(capsReached(chatOf({ modelTurnsLeft: 0 }))).toBe(false);
    expect(capsReached(chatOf({ modelTurnsLeft: 1, messages: [fallback] }))).toBe(false);
  });

  it("knows after a lost answer whether the server recorded the learner's turn (P-14)", () => {
    const shown = 3;
    const recordedText = chatOf({ messages: [message({ ordinal: 4, role: "learner", kind: "text", text: "hello" })] });
    expect(turnWasRecorded(recordedText, shown, { text: "hello" })).toBe(true);
    expect(turnWasRecorded(recordedText, shown, { text: "other" })).toBe(false);
    expect(turnWasRecorded(recordedText, 4, { text: "hello" })).toBe(false);
    const recordedQuick = chatOf({ messages: [message({ ordinal: 4, role: "learner", kind: "quick_reply", text: "More minutes" })] });
    expect(turnWasRecorded(recordedQuick, shown, {})).toBe(true);
    expect(turnWasRecorded(recordedText, shown, {})).toBe(false);
  });
});

describe("failure mapping (UI-screens S-34 States)", () => {
  const api = (status: number, code: string, details: Record<string, unknown> = {}, retryAfterSec: number | null = null) => new ApiError({ status, code, message: "m", details, retryAfterSec });

  it("maps the conflicts of E32 and E34 by their reason", () => {
    for (const reason of ["chat_closed", "proposal_stale", "plan_version", "active_plan_conflict", "plan_not_active"] as const) {
      expect(classifyChatError(api(409, "version_conflict", { reason }))).toEqual({ kind: reason });
    }
    expect(classifyChatError(api(409, "version_conflict", { reason: "estimate_changed" }))).toEqual({ kind: "internal" });
  });

  it("maps the other documented outcomes", () => {
    expect(classifyChatError(api(401, "unauthenticated"))).toEqual({ kind: "session_ended" });
    expect(classifyChatError(api(404, "not_found"))).toEqual({ kind: "not_found" });
    expect(classifyChatError(api(429, "throttled", {}, 20))).toEqual({ kind: "throttled", retryAfterSec: 20 });
    expect(classifyChatError(api(503, "unavailable"))).toEqual({ kind: "unavailable" });
    expect(classifyChatError(api(403, "forbidden_origin"))).toEqual({ kind: "origin" });
    expect(classifyChatError(api(500, "internal"))).toEqual({ kind: "internal" });
    expect(classifyChatError(api(422, "validation_error", { fields: [{ field: "editionId", rule: "edition_not_available" }, { field: "x" }] }))).toEqual({ kind: "validation", rules: ["edition_not_available"] });
    expect(classifyChatError(api(422, "validation_error"))).toEqual({ kind: "validation", rules: [] });
  });

  it("treats a lost answer as connectivity and an abort as nothing to say", () => {
    expect(classifyChatError(new ConnectivityError("network"))).toEqual({ kind: "connectivity" });
    expect(classifyChatError(new DOMException("x", "AbortError"))).toEqual({ kind: "aborted" });
    expect(classifyChatError(new Error("boom"))).toEqual({ kind: "internal" });
  });
});
