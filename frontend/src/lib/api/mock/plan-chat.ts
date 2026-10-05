// The mock plan conversation (E31 to E34, D75, Plan-conversation "mock conversation in memory mode"). It plays the rules engine and the guard
// for synthetic data: no model is called, every number comes from this file, and nothing outlives the page.
import type { ChatMessage, Estimate, ISODate, Path, Plan, PlanChat, PlanOrder, PlanProposal, PlanSections, QuickReply, QuickReplyCode } from "../types";
import type { MockHandler, MockResponse } from "./handlers";
import { mockCatalog, MOCK_PLAN_ID, mockToday } from "./fixtures";
import {
  MOCK_CHANGED_ELSEWHERE_TEXT,
  MOCK_CHAT_GOALS,
  MOCK_CHAT_TEXTS,
  MOCK_FALLBACK,
  MOCK_NO_CHANGE_TEXT,
  MOCK_OUT_OF_SCOPE_WORDS,
  MOCK_PROPOSAL_TEXT,
  MOCK_QUICK_REPLIES,
  MOCK_REDIRECT,
  MOCK_REFUSAL,
  MOCK_RELIGIOUS_WORDS,
  MOCK_UPDATED_TEXT,
} from "./plan-chat-fixtures";

type Language = "ar" | "en";
type Minutes = 5 | 10 | 15;

interface Params {
  editionId: string;
  scope: number[];
  paths: Path[];
  order: PlanOrder;
  sessionMinutes: Minutes;
  preferredDate: ISODate | null;
}

type Special = "stale" | "plan_moved" | "race" | "inactive";

interface MockChat {
  chatId: string;
  status: PlanChat["status"];
  planId: string | null;
  language: Language;
  messages: ChatMessage[];
  params: Params;
  proposal: PlanProposal;
  planVersion: number | null; // a revision keeps the plan's version it started from
  fallbackShown: boolean;
  special: Special | null;
}

export interface MockPlanChatStore {
  chats: Map<string, MockChat>;
  chatCount: number;
  messageCount: number;
}

const MODEL_TURNS_LEFT = 6;
const MESSAGE_LIMIT = 500;
const NEW_PLAN_ID = "44444444-4444-4444-8444-000000000003";
const CREATED_AT = "2026-10-05T09:05:00Z";
const WORDS_PER_DAY: Record<Minutes, number> = { 5: 10, 10: 20, 15: 30 };

const error = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({
  status,
  body: { error: { code, message, details } },
});
const unauthenticated = (): MockResponse => error(401, "unauthenticated", "Authentication is required.");
const validation = (fields: { field: string; rule: string }[]): MockResponse => error(422, "validation_error", "The request body is not valid.", { fields });
const conflict = (reason: string, details: Record<string, unknown> = {}): MockResponse => error(409, "version_conflict", "The request conflicts with the current state.", { reason, ...details });
const notFound = (): MockResponse => error(404, "not_found", "The conversation was not found.");

function store(scenario: { planChats?: MockPlanChatStore }): MockPlanChatStore {
  scenario.planChats ??= { chats: new Map(), chatCount: 0, messageCount: 0 };
  return scenario.planChats;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const codePoints = (text: string): number => Array.from(text).length;
const pad = (value: number): string => String(value).padStart(12, "0");

function addDays(date: ISODate, days: number): ISODate {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// The digits of the language, so a server-built text follows the same rule as the client (O-29).
function digits(language: Language, value: number | string): string {
  const text = String(value);
  return language === "ar" ? text.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit))) : text;
}

function editionOf(editionId: string) {
  return mockCatalog.editions.find((edition) => edition.editionId === editionId);
}

function estimateOf(params: Params): Estimate {
  const edition = editionOf(params.editionId);
  const sections = (edition?.sections ?? []).filter((section) => params.scope.includes(section.ordinal));
  const totalWords = sections.reduce((sum, section) => sum + section.wordCount, 0);
  const perDay = WORDS_PER_DAY[params.sessionMinutes];
  const days = Math.max(1, Math.ceil(totalWords / perDay));
  return {
    days,
    endDate: addDays(mockToday.learningDate, days),
    newWordsPerDay: Math.min(perDay, totalWords),
    totalWords,
    knownWords: 0,
    passageCount: sections.reduce((sum, section) => sum + section.passageCount, 0),
    sessionMinutes: params.sessionMinutes,
    scope: { sectionOrdinals: params.scope },
    paths: params.paths,
  };
}

function sectionsOf(params: Params, estimate: Estimate, language: Language): PlanSections {
  const edition = editionOf(params.editionId);
  const title = language === "ar" ? edition?.titleAr : edition?.titleEn;
  const n = (value: number): string => digits(language, value);
  const end = digits(language, estimate.endDate);
  const reverse = params.order === "reverse";
  if (language === "ar") {
    return {
      goal: `إتمام ${n(params.scope.length)} من أقسام «${title}»${reverse ? " بالترتيب العكسي" : ""}.`,
      totalTime: `${n(estimate.days)} يومًا تقريبًا، وتنتهي في ${end}.`,
      dailyTime: `${n(params.sessionMinutes)} دقائق في اليوم، بنحو ${n(estimate.newWordsPerDay)} كلمة جديدة.`,
      stages: "التعلم، ثم المراجعة، ثم التثبيت.",
      reviews: "مراجعات منتظمة بفواصل تتسع تدريجيًا.",
      nextStep: "ابدأ جلسة اليوم بعد اعتماد الخطة.",
    };
  }
  return {
    goal: `Complete ${n(params.scope.length)} section(s) of "${title}"${reverse ? " in reverse order" : ""}.`,
    totalTime: `About ${n(estimate.days)} days, ending on ${end}.`,
    dailyTime: `${n(params.sessionMinutes)} minutes a day, about ${n(estimate.newWordsPerDay)} new words.`,
    stages: "Learning, then review, then consolidation.",
    reviews: "Regular reviews with gradually wider gaps.",
    nextStep: "Start today's session once the plan is confirmed.",
  };
}

function proposalOf(params: Params, version: number, language: Language): PlanProposal {
  const estimate = estimateOf(params);
  return {
    proposalVersion: version,
    editionId: params.editionId,
    targetScope: { sectionOrdinals: params.scope },
    paths: params.paths,
    order: params.order,
    sessionMinutes: params.sessionMinutes,
    preferredDate: params.preferredDate,
    estimate,
    sections: sectionsOf(params, estimate, language),
  };
}

// The shortcuts the rules offer next: one that cannot apply is absent (UA-14), and `confirm` closes the list.
function quickRepliesOf(chat: MockChat): QuickReply[] {
  const { params } = chat;
  const codes: QuickReplyCode[] = [];
  if (params.sessionMinutes > 5) codes.push("fewer_minutes");
  if (params.sessionMinutes < 15) codes.push("more_minutes");
  if (chat.planId === null && params.scope.length > 1) codes.push("smaller_scope"); // a revision never changes the scope (Plan-conversation 2.9)
  if (params.preferredDate !== null) codes.push("later_date", "no_date");
  if (params.paths.includes("quran")) codes.push(params.order === "book" ? "order_reverse" : "order_book");
  else codes.push(params.paths.length === 1 && params.paths[0] === "matn" ? "paths_all" : "paths_matn_only");
  codes.push("confirm");
  return codes.map((code) => MOCK_QUICK_REPLIES[code]);
}

function viewOf(chat: MockChat): PlanChat {
  return {
    chatId: chat.chatId,
    status: chat.status,
    planId: chat.planId,
    language: chat.language,
    messages: chat.messages,
    proposal: chat.proposal,
    quickReplies: chat.status === "open" ? quickRepliesOf(chat) : [],
    modelTurnsLeft: MODEL_TURNS_LEFT,
    assistant: { source: "rules" },
  };
}

function append(chat: MockChat, store: MockPlanChatStore, role: ChatMessage["role"], kind: ChatMessage["kind"], text: string, source: ChatMessage["source"]): void {
  store.messageCount += 1;
  chat.messages.push({
    messageId: `77777777-7777-4777-8777-${pad(store.messageCount)}`,
    ordinal: chat.messages.length + 1,
    role,
    kind,
    text,
    source,
    createdAt: CREATED_AT,
  });
}

const fixed = (texts: { ar: string; en: string }, language: Language): string => texts[language];

function classify(text: string): "religious" | "out_of_scope" | "logistics" {
  if (MOCK_RELIGIOUS_WORDS.test(text)) return "religious";
  if (MOCK_OUT_OF_SCOPE_WORDS.test(text)) return "out_of_scope";
  return "logistics";
}

function readMinutes(text: string): Minutes | null {
  const western = text.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
  const match = /(?<!\d)(5|10|15)(?!\d)/.exec(western);
  return match ? (Number(match[1]) as Minutes) : null;
}

function withProposal(chat: MockChat, params: Params): boolean {
  const changed = JSON.stringify(params) !== JSON.stringify(chat.params);
  if (!changed) return false;
  chat.params = params;
  chat.proposal = proposalOf(params, chat.proposal.proposalVersion + 1, chat.language);
  return true;
}

function patchOf(code: QuickReplyCode, chat: MockChat): Params {
  const { params } = chat;
  const next: Params = { ...params, scope: [...params.scope], paths: [...params.paths] };
  switch (code) {
    case "fewer_minutes":
      next.sessionMinutes = params.sessionMinutes === 15 ? 10 : 5;
      break;
    case "more_minutes":
      next.sessionMinutes = params.sessionMinutes === 5 ? 10 : 15;
      break;
    case "smaller_scope":
      if (chat.planId === null) next.scope = params.scope.slice(0, Math.max(1, Math.ceil(params.scope.length / 2)));
      break;
    case "later_date": {
      const days = estimateOf(params).days;
      next.preferredDate = addDays(params.preferredDate ?? addDays(mockToday.learningDate, days), Math.max(1, Math.ceil(days * 0.25)));
      break;
    }
    case "no_date":
      next.preferredDate = null;
      break;
    case "order_book":
      next.order = "book";
      break;
    case "order_reverse":
      if (params.paths.includes("quran")) next.order = "reverse";
      break;
    case "paths_matn_only":
      if (!params.paths.includes("quran")) next.paths = ["matn"];
      break;
    case "paths_all":
      if (!params.paths.includes("quran")) next.paths = ["matn", "sanad", "grade"];
      break;
    case "confirm":
      break;
  }
  return next;
}

const E31_FIELDS = ["editionId", "targetScope", "paths", "sessionMinutes", "preferredDate", "placementSessionId", "goalText", "language", "planId"] as const;
const isIsoDate = (value: unknown): value is ISODate => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

// E31: validation in the order of API-spec 4.10.1, then the first assistant turn built from the form.
const createChat: MockHandler = ({ body }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const fields: Record<string, unknown> = isRecord(body) ? body : {};
  const broken: { field: string; rule: string }[] = Object.keys(fields)
    .filter((field) => !(E31_FIELDS as readonly string[]).includes(field))
    .map((field) => ({ field, rule: "forbidden_field" }));
  const required: Record<string, boolean> = {
    editionId: typeof fields.editionId === "string",
    targetScope: isRecord(fields.targetScope) && Array.isArray(fields.targetScope.sectionOrdinals),
    paths: Array.isArray(fields.paths),
    sessionMinutes: typeof fields.sessionMinutes === "number",
    goalText: typeof fields.goalText === "string",
    language: fields.language === "ar" || fields.language === "en",
  };
  for (const [field, ok] of Object.entries(required)) if (!ok) broken.push({ field, rule: "invalid_type" });
  if (broken.length > 0) return validation(broken);

  const goalText = (fields.goalText as string).trim();
  const edition = editionOf(fields.editionId as string);
  if (edition === undefined || goalText.includes(MOCK_CHAT_GOALS.editionGone)) return validation([{ field: "editionId", rule: "edition_not_available" }]);

  const rules: { field: string; rule: string }[] = [];
  const ordinals = (fields.targetScope as { sectionOrdinals: unknown[] }).sectionOrdinals;
  const known = edition.sections.map((section) => section.ordinal);
  if (ordinals.length === 0 || ordinals.length > 60 || !ordinals.every((ordinal) => typeof ordinal === "number" && known.includes(ordinal))) rules.push({ field: "targetScope", rule: "scope_invalid" });
  const paths = fields.paths as unknown[];
  if (paths.length === 0 || !paths.every((path) => (edition.availablePaths as unknown[]).includes(path)) || new Set(paths).size !== paths.length) rules.push({ field: "paths", rule: "path_not_available" });
  if (![5, 10, 15].includes(fields.sessionMinutes as number)) rules.push({ field: "sessionMinutes", rule: "session_minutes_invalid" });
  const date = fields.preferredDate;
  if (date !== undefined && (!isIsoDate(date) || date < mockToday.learningDate)) rules.push({ field: "preferredDate", rule: "date_invalid" });
  if (codePoints(goalText) > MESSAGE_LIMIT) rules.push({ field: "goalText", rule: "goal_text_length" });
  if (rules.length > 0) return validation(rules);

  if (fields.planId !== undefined && fields.planId !== MOCK_PLAN_ID) return notFound();
  if (fields.placementSessionId !== undefined) return notFound(); // the mock holds no placement session

  const data = store(scenario);
  for (const open of data.chats.values()) if (open.status === "open") open.status = "abandoned";
  data.chatCount += 1;

  const language = fields.language as Language;
  const params: Params = {
    editionId: edition.editionId,
    scope: [...(ordinals as number[])].sort((a, b) => a - b),
    paths: paths as Path[],
    order: "book",
    sessionMinutes: fields.sessionMinutes as Minutes,
    preferredDate: typeof date === "string" ? date : null,
  };
  const planId = typeof fields.planId === "string" ? fields.planId : null;
  const special: Special | null = goalText.includes(MOCK_CHAT_GOALS.stale)
    ? "stale"
    : goalText.includes(MOCK_CHAT_GOALS.planMoved) && planId !== null
      ? "plan_moved"
      : goalText.includes(MOCK_CHAT_GOALS.race)
        ? "race"
        : goalText.includes(MOCK_CHAT_GOALS.inactive)
          ? "inactive"
          : null;
  const chat: MockChat = {
    chatId: `66666666-6666-4666-8666-${pad(data.chatCount)}`,
    status: "open",
    planId,
    language,
    messages: [],
    params,
    proposal: proposalOf(params, 1, language),
    planVersion: planId === null ? null : mockToday.plan?.currentVersion ?? 1,
    fallbackShown: false,
    special,
  };
  // A goal text that asks for a ruling or is off topic gets the fixed line first, then the rules proposal from the form (Plan-conversation 2.9).
  const guard = classify(goalText);
  if (guard === "religious") append(chat, data, "assistant", "refusal", fixed(MOCK_REFUSAL, language), "fixed");
  else if (guard === "out_of_scope") append(chat, data, "assistant", "redirect", fixed(MOCK_REDIRECT, language), "fixed");
  append(chat, data, "assistant", "proposal", fixed(MOCK_PROPOSAL_TEXT, language), "rules");
  data.chats.set(chat.chatId, chat);
  return { status: 201, body: viewOf(chat) };
};

const E32_FIELDS = ["text", "quickReply"] as const;

// E32: the turn pipeline of Plan-conversation 2.4 with the model switched off: guard, quick-reply rules, then the fallback.
const sendTurn: MockHandler = ({ body, params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const data = store(scenario);
  const chat = data.chats.get(params?.id ?? "");
  if (chat === undefined) return notFound();
  if (chat.status !== "open") return conflict("chat_closed");

  const fields: Record<string, unknown> = isRecord(body) ? body : {};
  const broken: { field: string; rule: string }[] = Object.keys(fields)
    .filter((field) => !(E32_FIELDS as readonly string[]).includes(field))
    .map((field) => ({ field, rule: "forbidden_field" }));
  const hasText = fields.text !== undefined;
  const hasQuick = fields.quickReply !== undefined;
  if (hasText === hasQuick) broken.push({ field: "text", rule: "one_of_text_or_quick_reply" });
  else if (hasText && (typeof fields.text !== "string" || codePoints(fields.text.trim()) > MESSAGE_LIMIT)) broken.push({ field: "text", rule: typeof fields.text === "string" ? "text_length" : "invalid_type" });
  else if (hasQuick && !Object.hasOwn(MOCK_QUICK_REPLIES, String(fields.quickReply))) broken.push({ field: "quickReply", rule: "quick_reply_invalid" });
  else if (fields.quickReply === "confirm") broken.push({ field: "quickReply", rule: "quick_reply_confirm_use_e34" });
  if (broken.length > 0) return validation(broken);

  const language = chat.language;
  if (typeof fields.text === "string") {
    const text = fields.text.trim();
    if (text.includes(MOCK_CHAT_TEXTS.throttled)) return error(429, "throttled", "Too many attempts.", { retryAfterSec: 20 });
    if (text.includes(MOCK_CHAT_TEXTS.unavailable)) return error(503, "unavailable", "The service is temporarily unavailable.");
    if (text.includes(MOCK_CHAT_TEXTS.internal)) return error(500, "internal", "Unexpected error.");
    append(chat, data, "learner", "text", text, "learner");
    const guard = classify(text);
    if (guard === "religious") append(chat, data, "assistant", "refusal", fixed(MOCK_REFUSAL, language), "fixed");
    else if (guard === "out_of_scope") append(chat, data, "assistant", "redirect", fixed(MOCK_REDIRECT, language), "fixed");
    else {
      const minutes = readMinutes(text);
      const changed = minutes !== null && withProposal(chat, { ...chat.params, sessionMinutes: minutes });
      if (changed) append(chat, data, "assistant", "proposal", fixed(MOCK_UPDATED_TEXT, language), "rules");
      else if (!chat.fallbackShown) {
        chat.fallbackShown = true; // the notice shows once per conversation (G-35)
        append(chat, data, "assistant", "fallback", fixed(MOCK_FALLBACK, language), "rules");
      } else append(chat, data, "assistant", "text", fixed(MOCK_NO_CHANGE_TEXT, language), "rules");
    }
  } else {
    const code = fields.quickReply as QuickReplyCode;
    const label = MOCK_QUICK_REPLIES[code];
    append(chat, data, "learner", "quick_reply", language === "ar" ? label.labelAr : label.labelEn, "learner");
    if (withProposal(chat, patchOf(code, chat))) append(chat, data, "assistant", "proposal", fixed(MOCK_UPDATED_TEXT, language), "rules");
    else append(chat, data, "assistant", "text", fixed(MOCK_NO_CHANGE_TEXT, language), "rules");
  }
  return { status: 200, body: viewOf(chat) };
};

const readChat: MockHandler = ({ params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const chat = store(scenario).chats.get(params?.id ?? "");
  return chat === undefined ? notFound() : { status: 200, body: viewOf(chat) };
};

// E34: saves exactly the proposal the learner saw, or answers 409 (R24). A confirmed plan makes the mock account hold a plan.
const confirmChat: MockHandler = ({ body, params }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const data = store(scenario);
  const chat = data.chats.get(params?.id ?? "");
  if (chat === undefined) return notFound();
  if (chat.status !== "open") return conflict("chat_closed");

  const fields: Record<string, unknown> = isRecord(body) ? body : {};
  const broken = Object.keys(fields)
    .filter((field) => field !== "proposalVersion")
    .map((field) => ({ field, rule: "forbidden_field" }));
  if (!Number.isInteger(fields.proposalVersion)) broken.push({ field: "proposalVersion", rule: "invalid_type" });
  if (broken.length > 0) return validation(broken);

  if (chat.special === "inactive") return conflict("plan_not_active");
  if (chat.special === "plan_moved") return conflict("plan_version", { currentVersion: (chat.planVersion ?? 1) + 1 });
  if (chat.special === "race") {
    chat.special = null;
    return conflict("active_plan_conflict");
  }
  if (chat.special === "stale") {
    // Someone else changed the proposal: the conversation moves to a newer one and the learner has to look again.
    chat.special = null;
    withProposal(chat, { ...chat.params, sessionMinutes: chat.params.sessionMinutes === 15 ? 10 : 15 });
    append(chat, data, "assistant", "proposal", fixed(MOCK_CHANGED_ELSEWHERE_TEXT, chat.language), "rules");
    return conflict("proposal_stale", { proposal: chat.proposal });
  }
  if (fields.proposalVersion !== chat.proposal.proposalVersion) return conflict("proposal_stale", { proposal: chat.proposal });

  const edition = editionOf(chat.params.editionId);
  const plan: Plan = {
    planId: chat.planId ?? NEW_PLAN_ID,
    editionId: chat.params.editionId,
    titleAr: edition?.titleAr ?? "",
    titleEn: edition?.titleEn ?? "",
    targetScope: { sectionOrdinals: chat.params.scope },
    paths: chat.params.paths,
    order: chat.params.order,
    sessionMinutes: chat.params.sessionMinutes,
    preferredDate: chat.params.preferredDate,
    agreedEstimate: chat.proposal.estimate,
    currentVersion: chat.planId === null ? 1 : (chat.planVersion ?? 1) + 1,
    status: "active",
    createdAt: CREATED_AT,
    planner: { source: "rules" },
  };
  chat.status = "confirmed";
  scenario.hasPlan = true;
  return { status: chat.planId === null ? 201 : 200, body: plan };
};

// Keys follow mock-fetch: ":id" matches one path segment.
export const planChatHandlers: Readonly<Record<string, MockHandler>> = {
  "POST /plan-chats": createChat,
  "POST /plan-chats/:id/messages": sendTurn,
  "GET /plan-chats/:id": readChat,
  "POST /plan-chats/:id/confirm": confirmChat,
};
