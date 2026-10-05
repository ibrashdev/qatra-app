import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/api/client";
import { createEndpoints, type Endpoints } from "@/lib/api/endpoints";
import { ApiError, isSessionEnded } from "@/lib/api/errors";
import { createMockFetch, MOCK_CHAT_GOALS, MOCK_CHAT_TEXTS, MOCK_HADITH_EDITION_ID, MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, MOCK_REDIRECT, MOCK_REFUSAL, mockProfile, type MockScenario } from "@/lib/api/mock";
import type { CreatePlanChatRequest, PlanChat } from "@/lib/api/types";

function mockApi(scenario: Partial<MockScenario> = {}) {
  const client = createApiClient({ fetch: createMockFetch({ latencyMs: 0, scenario }) });
  return { client, api: createEndpoints(client) };
}

const request = (over: Partial<CreatePlanChatRequest> = {}): CreatePlanChatRequest => ({
  editionId: MOCK_QURAN_EDITION_ID,
  targetScope: { sectionOrdinals: [1, 2] },
  paths: ["quran"],
  sessionMinutes: 5,
  preferredDate: "2026-10-20",
  goalText: "Synthetic goal sentence",
  language: "en",
  ...over,
});

const failure = async (promise: Promise<unknown>) => (await promise.catch((e: unknown) => e)) as ApiError;
const codes = (chat: PlanChat) => chat.quickReplies.map((reply) => reply.code);
const reasonOf = (error: ApiError) => error.details.reason;

async function start(api: Endpoints, over: Partial<CreatePlanChatRequest> = {}): Promise<PlanChat> {
  return api.createPlanChat(request(over));
}

describe("E31 POST /api/plan-chats (mock conversation)", () => {
  it("answers 201 with an open conversation whose first message is a rules proposal of version 1", async () => {
    const { api } = mockApi();
    const chat = await start(api);
    expect(chat).toMatchObject({ status: "open", planId: null, language: "en", modelTurnsLeft: 6, assistant: { source: "rules" } });
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ ordinal: 1, role: "assistant", kind: "proposal", source: "rules" });
    expect(chat.proposal?.proposalVersion).toBe(1);
    expect(chat.proposal?.order).toBe("book");
    expect(Object.keys(chat.proposal?.sections ?? {})).toEqual(["goal", "totalTime", "dailyTime", "stages", "reviews", "nextStep"]);
    for (const value of Object.values(chat.proposal?.sections ?? {})) expect(value.length).toBeGreaterThan(0);
    expect(chat.chatId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("offers the shortcuts the rules allow, in the server order, with confirm last", async () => {
    const { api } = mockApi();
    expect(codes(await start(api))).toEqual(["more_minutes", "smaller_scope", "later_date", "no_date", "order_reverse", "confirm"]);
    expect(codes(await start(api, { sessionMinutes: 10, targetScope: { sectionOrdinals: [1] } }))).toEqual(["fewer_minutes", "more_minutes", "later_date", "no_date", "order_reverse", "confirm"]);
    expect(codes(await start(api, { sessionMinutes: 15, preferredDate: undefined }))).toEqual(["fewer_minutes", "smaller_scope", "order_reverse", "confirm"]);
  });

  it("offers the path shortcuts for a hadith edition, never the reverse order", async () => {
    const { api } = mockApi();
    const chat = await start(api, { editionId: MOCK_HADITH_EDITION_ID, targetScope: { sectionOrdinals: [1] }, paths: ["matn"] });
    expect(codes(chat)).toContain("paths_all");
    expect(codes(chat)).not.toContain("order_reverse");
    expect(codes(chat)).not.toContain("paths_matn_only");
  });

  it("replaces the open conversation of the account: the earlier one becomes abandoned", async () => {
    const { api } = mockApi();
    const first = await start(api);
    const second = await start(api);
    expect(second.chatId).not.toBe(first.chatId);
    expect((await api.planChat(first.chatId)).status).toBe("abandoned");
    expect((await api.planChat(second.chatId)).status).toBe("open");
  });

  it("starts a revision conversation with the plan id and never offers a smaller scope for it", async () => {
    const { api } = mockApi();
    const chat = await start(api, { planId: MOCK_PLAN_ID });
    expect(chat.planId).toBe(MOCK_PLAN_ID);
    expect(codes(chat)).not.toContain("smaller_scope");
  });

  it("puts the fixed refusal first when the goal text asks for a ruling, then the rules proposal", async () => {
    const chat = await start(mockApi().api, { goalText: "what is the ruling on this" });
    expect(chat.messages.map((message) => message.kind)).toEqual(["refusal", "proposal"]);
    expect(chat.messages[0]?.text).toBe(MOCK_REFUSAL.en);
    expect(chat.messages[0]?.source).toBe("fixed");
  });

  it("answers the rules of the shared checks with validation_error and the rule names", async () => {
    const { api } = mockApi();
    const rules = async (over: Partial<CreatePlanChatRequest>) => (await failure(start(api, over))).details.fields;
    expect(await rules({ goalText: "x".repeat(501) })).toEqual([{ field: "goalText", rule: "goal_text_length" }]);
    expect(await rules({ paths: ["matn"] })).toEqual([{ field: "paths", rule: "path_not_available" }]);
    expect(await rules({ sessionMinutes: 7 as 5 })).toEqual([{ field: "sessionMinutes", rule: "session_minutes_invalid" }]);
    expect(await rules({ preferredDate: "2020-01-01" })).toEqual([{ field: "preferredDate", rule: "date_invalid" }]);
    expect(await rules({ targetScope: { sectionOrdinals: [9] } })).toEqual([{ field: "targetScope", rule: "scope_invalid" }]);
    expect(await rules({ editionId: "11111111-1111-4111-8111-00000000ffff" })).toEqual([{ field: "editionId", rule: "edition_not_available" }]);
    expect(await rules({ goalText: MOCK_CHAT_GOALS.editionGone })).toEqual([{ field: "editionId", rule: "edition_not_available" }]);
  });

  it("counts the goal text in code points: 500 is allowed, 501 is not", async () => {
    const { api } = mockApi();
    await expect(start(api, { goalText: "\u{1F4A7}".repeat(500) })).resolves.toBeDefined();
    expect((await failure(start(api, { goalText: "\u{1F4A7}".repeat(501) }))).code).toBe("validation_error");
  });

  it("refuses a property outside the contract, and an unknown plan or placement session is not found", async () => {
    const { api, client } = mockApi();
    const extra = await failure(client.post("/plan-chats", { ...request(), userId: "x" }));
    expect([extra.status, extra.code, extra.details]).toEqual([422, "validation_error", { fields: [{ field: "userId", rule: "forbidden_field" }] }]);
    expect((await failure(start(api, { planId: "44444444-4444-4444-8444-0000000000ff" }))).code).toBe("not_found");
    expect((await failure(start(api, { placementSessionId: "33333333-3333-4333-8333-000000000001" }))).code).toBe("not_found");
  });

  it("is a session operation: signed out it answers 401 unauthenticated", async () => {
    const { api } = mockApi({ signedIn: false });
    expect(isSessionEnded(await failure(start(api)))).toBe(true);
    expect(isSessionEnded(await failure(api.planChat("66666666-6666-4666-8666-000000000001")))).toBe(true);
  });
});

describe("E32 POST /api/plan-chats/:id/messages", () => {
  it("a quick reply changes the proposal: the version rises and the numbers come from the rules", async () => {
    const { api } = mockApi();
    const first = await start(api);
    const next = await api.sendPlanChatTurn(first.chatId, { quickReply: "more_minutes" });
    expect(next.proposal?.proposalVersion).toBe(2);
    expect(next.proposal?.sessionMinutes).toBe(10);
    expect(next.proposal?.estimate.days).toBeLessThan(first.proposal?.estimate.days ?? 0);
    expect(next.messages.map((message) => [message.role, message.kind])).toEqual([
      ["assistant", "proposal"],
      ["learner", "quick_reply"],
      ["assistant", "proposal"],
    ]);
    expect(next.messages.map((message) => message.ordinal)).toEqual([1, 2, 3]);
    expect(next.messages[1]?.text).toBe("More minutes");
    expect(codes(next)).toContain("fewer_minutes");
    expect(next.modelTurnsLeft).toBe(6);
  });

  it("smaller scope halves the scope, later date moves the date, no date clears it, order flips for the Quran", async () => {
    const { api } = mockApi();
    const chat = await start(api);
    const smaller = await api.sendPlanChatTurn(chat.chatId, { quickReply: "smaller_scope" });
    expect(smaller.proposal?.targetScope.sectionOrdinals).toEqual([1]);
    const later = await api.sendPlanChatTurn(chat.chatId, { quickReply: "later_date" });
    expect((later.proposal?.preferredDate ?? "") > "2026-10-20").toBe(true);
    const reversed = await api.sendPlanChatTurn(chat.chatId, { quickReply: "order_reverse" });
    expect(reversed.proposal?.order).toBe("reverse");
    expect(codes(reversed)).toContain("order_book");
    const none = await api.sendPlanChatTurn(chat.chatId, { quickReply: "no_date" });
    expect(none.proposal?.preferredDate).toBeNull();
    expect(codes(none)).not.toContain("no_date");
  });

  it("a shortcut that changes nothing keeps the version and says so", async () => {
    const { api } = mockApi();
    const chat = await start(api, { sessionMinutes: 15 });
    const next = await api.sendPlanChatTurn(chat.chatId, { quickReply: "more_minutes" });
    expect(next.proposal?.proposalVersion).toBe(1);
    expect(next.messages.at(-1)?.kind).toBe("text");
  });

  it("answers the fixed refusal for a religious question and the fixed redirect for an off-topic one, without changing the proposal", async () => {
    const { api } = mockApi();
    const chat = await start(api);
    const refused = await api.sendPlanChatTurn(chat.chatId, { text: "Please explain the meaning" });
    expect(refused.messages.at(-1)).toMatchObject({ kind: "refusal", source: "fixed", text: MOCK_REFUSAL.en });
    const redirected = await api.sendPlanChatTurn(chat.chatId, { text: "what is the weather" });
    expect(redirected.messages.at(-1)).toMatchObject({ kind: "redirect", source: "fixed", text: MOCK_REDIRECT.en });
    expect(redirected.proposal?.proposalVersion).toBe(1);
  });

  it("reads minutes from free text, and otherwise shows the fallback notice once per conversation", async () => {
    const { api } = mockApi();
    const chat = await start(api);
    const changed = await api.sendPlanChatTurn(chat.chatId, { text: "make it 15 minutes please" });
    expect(changed.proposal).toMatchObject({ proposalVersion: 2, sessionMinutes: 15 });
    const first = await api.sendPlanChatTurn(chat.chatId, { text: "something unclear" });
    expect(first.messages.at(-1)?.kind).toBe("fallback");
    const second = await api.sendPlanChatTurn(chat.chatId, { text: "still unclear" });
    expect(second.messages.at(-1)?.kind).toBe("text");
    expect(second.messages.filter((message) => message.kind === "fallback")).toHaveLength(1);
  });

  it("writes the learner message in the language of the conversation", async () => {
    const { api } = mockApi();
    const chat = await start(api, { language: "ar" });
    const next = await api.sendPlanChatTurn(chat.chatId, { quickReply: "no_date" });
    expect(next.messages.at(-2)?.text).toBe("دون موعد محدد");
  });

  it("rejects both or neither of text and quickReply, an over-long text, an unknown code, confirm and any other property", async () => {
    const { api, client } = mockApi();
    const chat = await start(api);
    const post = (body: unknown) => failure(client.post(`/plan-chats/${chat.chatId}/messages`, body));
    expect((await post({ text: "a", quickReply: "no_date" })).details.fields).toEqual([{ field: "text", rule: "one_of_text_or_quick_reply" }]);
    expect((await post({})).details.fields).toEqual([{ field: "text", rule: "one_of_text_or_quick_reply" }]);
    expect((await post({ text: "x".repeat(501) })).details.fields).toEqual([{ field: "text", rule: "text_length" }]);
    expect((await post({ quickReply: "bogus" })).details.fields).toEqual([{ field: "quickReply", rule: "quick_reply_invalid" }]);
    expect((await post({ quickReply: "confirm" })).details.fields).toEqual([{ field: "quickReply", rule: "quick_reply_confirm_use_e34" }]);
    expect((await post({ text: "a", isDemo: true })).details.fields).toEqual([{ field: "isDemo", rule: "forbidden_field" }]);
  });

  it("answers the documented failures for the synthetic message texts", async () => {
    const { api } = mockApi();
    const chat = await start(api);
    const send = (text: string) => failure(api.sendPlanChatTurn(chat.chatId, { text }));
    expect(await send(MOCK_CHAT_TEXTS.throttled)).toMatchObject({ status: 429, code: "throttled", retryAfterSec: 20 });
    expect(await send(MOCK_CHAT_TEXTS.unavailable)).toMatchObject({ status: 503, code: "unavailable" });
    expect(await send(MOCK_CHAT_TEXTS.internal)).toMatchObject({ status: 500, code: "internal" });
    expect((await api.planChat(chat.chatId)).messages).toHaveLength(1);
  });

  it("answers 404 for an unknown conversation and 409 chat_closed once it is not open", async () => {
    const { api } = mockApi();
    expect((await failure(api.sendPlanChatTurn("66666666-6666-4666-8666-0000000000ff", { text: "a" }))).code).toBe("not_found");
    const chat = await start(api);
    await start(api);
    const closed = await failure(api.sendPlanChatTurn(chat.chatId, { text: "a" }));
    expect([closed.status, closed.code, reasonOf(closed)]).toEqual([409, "version_conflict", "chat_closed"]);
  });
});

describe("E33 GET /api/plan-chats/:id", () => {
  it("returns the conversation as it stands and answers 404 for an unknown id", async () => {
    const { api } = mockApi();
    const chat = await start(api);
    const sent = await api.sendPlanChatTurn(chat.chatId, { quickReply: "more_minutes" });
    expect(await api.planChat(chat.chatId)).toEqual(sent);
    expect((await failure(api.planChat("66666666-6666-4666-8666-0000000000ff"))).code).toBe("not_found");
  });

  it("matches the segment of the path, so an id with a slash is not found rather than another route", async () => {
    const { client } = mockApi();
    expect((await failure(client.get("/plan-chats/a/b"))).code).toBe("not_found");
    expect((await failure(client.get("/plan-chats/"))).code).toBe("not_found");
  });
});

describe("E34 POST /api/plan-chats/:id/confirm", () => {
  it("saves exactly the proposal shown: 201 with the plan, the conversation confirmed, the account holding a plan", async () => {
    const { api } = mockApi({ hasPlan: false });
    const chat = await start(api);
    const next = await api.sendPlanChatTurn(chat.chatId, { quickReply: "more_minutes" });
    const plan = await api.confirmPlanChat(chat.chatId, { proposalVersion: next.proposal?.proposalVersion ?? 0 });
    expect(plan).toMatchObject({ status: "active", currentVersion: 1, sessionMinutes: 10, planner: { source: "rules" }, agreedEstimate: next.proposal?.estimate });
    expect((await api.planChat(chat.chatId)).status).toBe("confirmed");
    expect((await api.today()).plan).not.toBeNull();
  });

  it("answers 409 proposal_stale with the current proposal when an older version is confirmed", async () => {
    const { api } = mockApi();
    const chat = await start(api);
    await api.sendPlanChatTurn(chat.chatId, { quickReply: "more_minutes" });
    const error = await failure(api.confirmPlanChat(chat.chatId, { proposalVersion: 1 }));
    expect([error.status, error.code, reasonOf(error)]).toEqual([409, "version_conflict", "proposal_stale"]);
    expect((error.details.proposal as { proposalVersion: number }).proposalVersion).toBe(2);
    expect((await api.planChat(chat.chatId)).status).toBe("open");
  });

  it("answers chat_closed for a conversation that is closed, a repeat of a confirm included", async () => {
    const { api } = mockApi();
    const chat = await start(api);
    await api.confirmPlanChat(chat.chatId, { proposalVersion: 1 });
    expect(reasonOf(await failure(api.confirmPlanChat(chat.chatId, { proposalVersion: 1 })))).toBe("chat_closed");
    expect(reasonOf(await failure(api.sendPlanChatTurn(chat.chatId, { text: "a" })))).toBe("chat_closed");
  });

  it("revises the plan in force: 200 with the next version", async () => {
    const { api } = mockApi();
    const chat = await start(api, { planId: MOCK_PLAN_ID });
    const next = await api.sendPlanChatTurn(chat.chatId, { quickReply: "more_minutes" });
    const plan = await api.confirmPlanChat(chat.chatId, { proposalVersion: next.proposal?.proposalVersion ?? 0 });
    expect(plan).toMatchObject({ planId: MOCK_PLAN_ID, currentVersion: 2, sessionMinutes: 10 });
  });

  it("validates the body: an integer proposalVersion and no other property", async () => {
    const { api, client } = mockApi();
    const chat = await start(api);
    const post = (body: unknown) => failure(client.post(`/plan-chats/${chat.chatId}/confirm`, body));
    expect((await post({})).details.fields).toEqual([{ field: "proposalVersion", rule: "invalid_type" }]);
    expect((await post({ proposalVersion: "1" })).details.fields).toEqual([{ field: "proposalVersion", rule: "invalid_type" }]);
    expect((await post({ proposalVersion: 1, mode: "x" })).details.fields).toEqual([{ field: "mode", rule: "forbidden_field" }]);
    expect((await failure(api.confirmPlanChat("66666666-6666-4666-8666-0000000000ff", { proposalVersion: 1 }))).code).toBe("not_found");
  });

  it("answers each documented conflict for the synthetic goal texts", async () => {
    const { api } = mockApi();
    const stale = await start(api, { goalText: MOCK_CHAT_GOALS.stale });
    const moved = await failure(api.confirmPlanChat(stale.chatId, { proposalVersion: 1 }));
    expect(reasonOf(moved)).toBe("proposal_stale");
    const newer = (moved.details.proposal as { proposalVersion: number }).proposalVersion;
    expect(newer).toBe(2);
    await expect(api.confirmPlanChat(stale.chatId, { proposalVersion: newer })).resolves.toMatchObject({ status: "active" });

    const race = await start(api, { goalText: MOCK_CHAT_GOALS.race });
    expect(reasonOf(await failure(api.confirmPlanChat(race.chatId, { proposalVersion: 1 })))).toBe("active_plan_conflict");
    await expect(api.confirmPlanChat(race.chatId, { proposalVersion: 1 })).resolves.toBeDefined();

    const revision = await start(api, { goalText: MOCK_CHAT_GOALS.planMoved, planId: MOCK_PLAN_ID });
    const conflict = await failure(api.confirmPlanChat(revision.chatId, { proposalVersion: 1 }));
    expect([reasonOf(conflict), conflict.details.currentVersion]).toEqual(["plan_version", 2]);

    const inactive = await start(api, { goalText: MOCK_CHAT_GOALS.inactive });
    expect(reasonOf(await failure(api.confirmPlanChat(inactive.chatId, { proposalVersion: 1 })))).toBe("plan_not_active");
  });
});

describe("endpoints over a live fetch (paths, methods, bodies)", () => {
  function spy() {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ chatId: "x" }), { status: 200 }));
    return { fetchSpy, api: createEndpoints(createApiClient({ fetch: fetchSpy })) };
  }

  it("calls E31 to E34 with the documented methods and paths, JSON bodies and the same-origin cookie", async () => {
    const { fetchSpy, api } = spy();
    const id = "66666666-6666-4666-8666-000000000001";
    await api.createPlanChat(request());
    await api.sendPlanChatTurn(id, { quickReply: "more_minutes" });
    await api.planChat(id);
    await api.confirmPlanChat(id, { proposalVersion: 2 });
    expect(fetchSpy.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      "POST /api/plan-chats",
      `POST /api/plan-chats/${id}/messages`,
      `GET /api/plan-chats/${id}`,
      `POST /api/plan-chats/${id}/confirm`,
    ]);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({ quickReply: "more_minutes" });
    expect(JSON.parse(String(fetchSpy.mock.calls[3]?.[1]?.body))).toEqual({ proposalVersion: 2 });
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });

  it("encodes the id as one path segment and refuses a dot segment before anything is sent", async () => {
    const { fetchSpy, api } = spy();
    await api.planChat("a/b");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/plan-chats/a%2Fb");
    await expect(api.planChat("..")).rejects.toBeInstanceOf(TypeError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never retries a row-creating call on its own, and retries a read only when asked", async () => {
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    });
    const sleeps: number[] = [];
    const client = createApiClient({ fetch: down, sleep: async (ms) => void sleeps.push(ms) });
    const api = createEndpoints(client);
    await expect(api.createPlanChat(request())).rejects.toBeDefined();
    await expect(api.sendPlanChatTurn("66666666-6666-4666-8666-000000000001", { text: "a" })).rejects.toBeDefined();
    await expect(api.confirmPlanChat("66666666-6666-4666-8666-000000000001", { proposalVersion: 1 })).rejects.toBeDefined();
    expect(down).toHaveBeenCalledTimes(3);
    await expect(api.planChat("66666666-6666-4666-8666-000000000001")).rejects.toBeDefined();
    expect(down).toHaveBeenCalledTimes(4);
    await expect(api.planChat("66666666-6666-4666-8666-000000000001", { retry: { delaysMs: [1, 2] } })).rejects.toBeDefined();
    expect(down).toHaveBeenCalledTimes(7);
    expect(sleeps).toEqual([1, 2]);
  });
});

describe("mock scenario for the screens", () => {
  it("holds synthetic texts only: no Uthmani marks, no dash, placeholders for the book", async () => {
    const chat = await start(mockApi().api);
    const serialized = JSON.stringify([chat, MOCK_REFUSAL, MOCK_REDIRECT]);
    expect(serialized).not.toMatch(/ۡ|ۥ|ۦ|ۢ|ۭ|۟/);
    expect(serialized).toContain("(placeholder)");
  });

  it("E11 answers a demo account when the scenario says so", async () => {
    expect((await mockApi({ isDemo: true }).api.me()).isDemo).toBe(true);
    expect(await mockApi().api.me()).toEqual(mockProfile);
  });

  it("keeps the conversations per mock session, so two sessions do not share one", async () => {
    const first = mockApi();
    const chat = await start(first.api);
    expect((await failure(mockApi().api.planChat(chat.chatId))).code).toBe("not_found");
  });
});
