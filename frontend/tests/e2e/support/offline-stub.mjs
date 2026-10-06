// A stateful stand-in for the offline endpoints of the backend, used only by the e2e run of the offline plan (R23). Specs that run with a service worker cannot use
// `page.route` (the interception does not see what a worker handles), so these answers come from the real stub server through the real /api rewrite.
//
// It is additive and opt-in: nothing here applies unless the request carries the cookie `qatra_e2e=<tenant>` (a spec sets it with `context.addCookies`), so every other
// spec and the plain stub behave exactly as before. Each tenant has its own state, which lets specs run in parallel and still inject faults:
//   POST /__stub/config?tenant=T   {user, signedIn, me401, planVersion, planActive, revoked, dropEventResponses, rateLimitNext, unavailableNext, eventDelayMs, serverLearningDate}
//   POST /api/sessions {kind: "daily"} serves one open daily session of the synthetic plan to an online run (answers to E21 without the offline envelope, E22 to finish)
//   GET  /__stub/state?tenant=T    what the "server" knows: acknowledged events, batches, snapshots, logout calls, the requests it saw
//   POST /__stub/reset?tenant=T
// Synthetic data only. The contract it follows: API-spec 4.12 (E23 to E25), E21, E22 and E10.
import { BANK_VERSION, buildSnapshot, EDITION_ID, snapshotId, userIdOf } from "./offline-stub-data.mjs";
import { today } from "./stub-data.mjs";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Stub-Backend": "1" };
const PLAN_ID = today.plan.planId;
const COOKIE = "qatra_e2e";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVELOPE_KEYS = ["clientRunId", "snapshotId", "protocolVersion", "planVersion", "editionId", "bankVersion", "normalizationPolicyVersion", "scoringPolicyVersion", "localSequence"];

const tenants = new Map();

function freshState() {
  return {
    user: "learner.a",
    signedIn: true,
    me401: false,
    planVersion: 1,
    planActive: true,
    revoked: false,
    dropEventResponses: 0,
    rateLimitNext: 0,
    unavailableNext: 0,
    eventDelayMs: 0,
    serverLearningDate: "2026-10-05",
    // what the server knows
    serial: 0,
    snapshots: new Map(),
    // The one open daily session an online run of the signed-in learner is served (E20 `daily`), apart from the downloaded snapshots counted above.
    onlineSnapshots: new Map(),
    onlineDaily: null,
    operations: new Map(),
    acknowledged: new Set(),
    pendingIds: new Set(),
    rejected: new Map(),
    eventLog: [],
    batches: 0,
    // Events the server already had (it answered `duplicate`): a resend that was needed, counted so a spec can say "nothing was sent twice".
    duplicates: 0,
    // Every E22 the server saw, with the Idempotency-Key it carried (null when the header was missing).
    completions: [],
    answerResults: [],
    intervals: [],
    logoutCalls: 0,
    requests: [],
  };
}

function stateOf(tenant) {
  let state = tenants.get(tenant);
  if (state === undefined) {
    state = freshState();
    tenants.set(tenant, state);
  }
  return state;
}

function tenantOf(request, url) {
  const fromQuery = url.searchParams.get("tenant");
  if (fromQuery) return fromQuery;
  const cookie = request.headers.cookie ?? "";
  const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

function send(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

const failure = (response, status, code, message, details = {}, headers = {}) => send(response, status, { error: { code, message, details } }, headers);

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text === "" ? undefined : JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    request.on("error", () => resolve(undefined));
  });
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function profileOf(state) {
  return {
    username: state.user,
    language: "ar",
    timeZone: "Asia/Dubai",
    sessionMinutes: 10,
    reminderSettings: { inApp: true },
    isDemo: false,
    termsVersion: "2026-10-04",
    termsAcceptedAt: "2026-10-04T08:00:00Z",
    createdAt: "2026-10-04T08:00:00Z",
    pendingSettings: null,
  };
}

function unionMs(intervals) {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let reachedEnd = Number.NEGATIVE_INFINITY;
  for (const [start, end] of sorted) {
    if (end <= reachedEnd) continue;
    total += end - Math.max(start, reachedEnd);
    reachedEnd = end;
  }
  return total;
}

function dailyOf(state) {
  const active = unionMs(state.intervals);
  const goal = today.dailyGoalMs;
  return {
    learningDate: state.serverLearningDate,
    dailyActiveMs: active,
    dailyGoalMs: goal,
    dailyPercent: Math.min(100, Math.floor((active * 100) / goal)),
    dailyCompleted: active >= goal,
    extraActiveMs: Math.max(0, active - goal),
  };
}

// arabic-norm-v1, as much as the synthetic answers need.
function normalise(text) {
  return String(text)
    .normalize("NFC")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function grade(question, answer) {
  switch (question.type) {
    case "word_order":
      return Array.isArray(answer?.order) && answer.order.length === question.answerKey.order.length && answer.order.every((ref, index) => ref === question.answerKey.order[index])
        ? { correct: true, expected: { order: question.answerKey.order } }
        : { correct: false, expected: { order: question.answerKey.order } };
    case "word_choice":
    case "similar_distinction":
      return { correct: answer?.optionId === question.answerKey.optionId, expected: { optionId: question.answerKey.optionId } };
    default:
      return { correct: typeof answer?.text === "string" && question.answerKey.acceptedNorms.includes(normalise(answer.text)), expected: {} };
  }
}

function findSession(state, sessionId) {
  for (const snapshot of state.snapshots.values()) {
    const session = snapshot.preparedSessions.find((entry) => entry.sessionId === sessionId);
    if (session !== undefined) return { snapshot, session, online: false };
  }
  for (const snapshot of state.onlineSnapshots.values()) {
    const session = snapshot.preparedSessions.find((entry) => entry.sessionId === sessionId);
    if (session !== undefined) return { snapshot, session, online: true };
  }
  return null;
}

// E20 `daily` (API-spec 4.7) for an online run: an atomic get-or-create of one open session, 201 the first time and 200 after. It is the daily descriptor of the
// synthetic plan, served as the server serves an open session, so the answers of the run reach E21 without the offline envelope.
function startDaily(state, response, body) {
  const fields = isRecord(body) ? body : {};
  if (fields.kind !== "daily") return failure(response, 422, "validation_error", "The request body is not valid.", { fields: [{ field: "kind", rule: "invalid_value" }] });
  if (fields.planId !== PLAN_ID) return failure(response, 404, "not_found", "The plan was not found.");
  if (!state.planActive) return failure(response, 409, "version_conflict", "The plan is not active.", { reason: "plan_not_active", currentVersion: state.planVersion });
  if (fields.expectedPlanVersion !== state.planVersion) return failure(response, 409, "version_conflict", "The plan version moved on.", { reason: "plan_version", currentVersion: state.planVersion });
  if (state.onlineDaily !== null) return send(response, 200, state.onlineDaily);
  state.serial += 1;
  const id = snapshotId(state.serial);
  const snapshot = buildSnapshot({ snapshotId: id, planId: PLAN_ID, planVersion: state.planVersion, userId: userIdOf(state.user), serial: state.serial, learningDate: state.serverLearningDate, dailyGoalMs: today.dailyGoalMs });
  const session = { ...snapshot.preparedSessions[0], status: "open" };
  state.onlineSnapshots.set(id, { ...snapshot, preparedSessions: [session] });
  state.onlineDaily = session;
  return send(response, 201, session);
}

// E23: 201 for a new snapshot, 200 for the same operation with the same input; 409 conflicts; the version and the plan state are the tenant's.
function createSnapshot(state, response, planId, body) {
  const fields = isRecord(body) ? body : {};
  const unknown = Object.keys(fields).filter((field) => !["clientOperationId", "expectedPlanVersion", "downloadTargetRefs"].includes(field));
  if (unknown.length > 0) return failure(response, 422, "validation_error", "The request body is not valid.", { fields: unknown.map((field) => ({ field, rule: "forbidden_field" })) });
  const broken = [];
  if (typeof fields.clientOperationId !== "string" || !UUID.test(fields.clientOperationId)) broken.push({ field: "clientOperationId", rule: "client_operation_id_invalid" });
  if (!Number.isInteger(fields.expectedPlanVersion) || fields.expectedPlanVersion < 1) broken.push({ field: "expectedPlanVersion", rule: "invalid_type" });
  if (fields.downloadTargetRefs !== undefined && (!Array.isArray(fields.downloadTargetRefs) || fields.downloadTargetRefs.length === 0)) broken.push({ field: "downloadTargetRefs", rule: "target_refs_invalid" });
  if (broken.length > 0) return failure(response, 422, "validation_error", "The request body is not valid.", { fields: broken });
  if (planId !== PLAN_ID) return failure(response, 404, "not_found", "The plan was not found.");
  if (!state.planActive) return failure(response, 409, "version_conflict", "The plan is not active.", { reason: "plan_not_active", currentVersion: state.planVersion });
  const earlier = state.operations.get(fields.clientOperationId);
  if (earlier !== undefined) {
    if (earlier.planVersion !== fields.expectedPlanVersion) return failure(response, 409, "version_conflict", "Operation id reused.", { reason: "idempotency_input", currentVersion: state.planVersion });
    return send(response, 200, state.snapshots.get(earlier.snapshotId));
  }
  if (fields.expectedPlanVersion !== state.planVersion) return failure(response, 409, "version_conflict", "The plan version moved on.", { reason: "plan_version", currentVersion: state.planVersion });
  state.serial += 1;
  const id = snapshotId(state.serial);
  const snapshot = buildSnapshot({ snapshotId: id, planId, planVersion: state.planVersion, userId: userIdOf(state.user), serial: state.serial, learningDate: state.serverLearningDate, dailyGoalMs: today.dailyGoalMs });
  state.snapshots.set(id, snapshot);
  state.operations.set(fields.clientOperationId, { snapshotId: id, planVersion: state.planVersion });
  return send(response, 201, snapshot);
}

function revalidate(state, response, body) {
  const fields = isRecord(body) ? body : {};
  const snapshot = typeof fields.snapshotId === "string" ? state.snapshots.get(fields.snapshotId) : undefined;
  if (snapshot === undefined) return failure(response, 404, "not_found", "The snapshot was not found.");
  if (snapshot.planVersion !== fields.expectedPlanVersion || snapshot.editionId !== fields.editionId || snapshot.bankVersion !== fields.bankVersion) {
    return failure(response, 422, "validation_error", "The request body is not valid.", { fields: [{ field: "snapshotId", rule: "snapshot_mismatch" }] });
  }
  const stale = state.planVersion !== snapshot.planVersion || !state.planActive;
  const status = state.revoked ? "revoked" : stale ? "stale" : "available";
  return send(response, 200, {
    status,
    currentPlanVersion: state.planVersion,
    allowedSessionRefs: status === "available" ? snapshot.preparedSessions.map((session) => session.sessionId) : [],
    catalogVersion: BANK_VERSION,
    reasonCode: status === "revoked" ? "content_revoked" : status === "stale" ? "plan_version_changed" : "current",
  });
}

// E21 for the prepared sessions: the checks of the server in their order. A processed batch can still lose its answer (`dropEventResponses`): the effects
// stay, so the resend must come back as `duplicate` and change nothing.
function events(state, request, response, sessionId, body) {
  const found = findSession(state, sessionId);
  if (found === null) return failure(response, 404, "not_found", "The session was not found.");
  const list = isRecord(body) && Array.isArray(body.events) ? body.events : null;
  if (list === null || list.length < 1 || list.length > 100) return failure(response, 422, "validation_error", "The request body is not valid.", { fields: [{ field: "events", rule: "invalid_type" }] });
  state.batches += 1;
  const result = { acknowledged: [], duplicate: [], pending: [], rejected: [], results: [], daily: dailyOf(state) };
  const questions = new Map(found.session.steps.flatMap((step) => (step.type === "question" ? [[step.question.questionId, step.question]] : [])));
  for (const event of list) {
    if (!isRecord(event) || typeof event.clientEventId !== "string" || !UUID.test(event.clientEventId)) return failure(response, 422, "validation_error", "The request body is not valid.", { fields: [{ field: "events", rule: "invalid_type" }] });
    const id = event.clientEventId;
    if (state.acknowledged.has(id)) {
      result.duplicate.push(id);
      state.duplicates += 1;
      continue;
    }
    // An online run sends no envelope (it is the replay envelope of an event recorded offline), so only a downloaded session is held to it.
    if (!found.online && !ENVELOPE_KEYS.every((key) => key in event)) {
      result.rejected.push({ clientEventId: id, code: "envelope_mismatch" });
      state.rejected.set(id, "envelope_mismatch");
      continue;
    }
    if (state.revoked) {
      result.rejected.push({ clientEventId: id, code: "edition_mismatch" });
      state.rejected.set(id, "edition_mismatch");
      continue;
    }
    if (!found.online && state.planVersion !== found.snapshot.planVersion) {
      result.pending.push({ clientEventId: id, reasonCode: "plan_changed_unverifiable" });
      state.pendingIds.add(id);
      continue;
    }
    state.pendingIds.delete(id);
    if (event.type === "activity") {
      state.intervals.push([Date.parse(event.startedAt), Date.parse(event.endedAt)]);
    } else {
      const question = questions.get(event.questionId);
      if (question === undefined) {
        result.rejected.push({ clientEventId: id, code: "question_not_in_session" });
        state.rejected.set(id, "question_not_in_session");
        continue;
      }
      const graded = grade(question, event.answer);
      state.answerResults.push({ clientEventId: id, correct: graded.correct });
      result.results.push({
        clientEventId: id,
        questionId: event.questionId,
        correct: graded.correct,
        assisted: event.hintUsed === true,
        expected: graded.expected,
        passage: { passageId: question.passageId, status: "learning", coveredParts: 1, totalParts: 2, consecutiveCorrect: graded.correct ? 1 : 0 },
      });
    }
    state.acknowledged.add(id);
    state.eventLog.push({ sessionId, clientEventId: id, type: event.type, localSequence: event.localSequence, clientRunId: event.clientRunId, snapshotId: event.snapshotId, occurredAt: event.occurredAt ?? event.startedAt });
    result.acknowledged.push(id);
  }
  result.daily = dailyOf(state);
  const finish = () => {
    if (state.dropEventResponses > 0) {
      // Committed, then the answer is lost: the connection dies without a response.
      state.dropEventResponses -= 1;
      request.socket.destroy();
      return;
    }
    send(response, 200, result);
  };
  if (state.eventDelayMs > 0) setTimeout(finish, state.eventDelayMs);
  else finish();
}

const APPLIED = ["user", "signedIn", "me401", "planVersion", "planActive", "revoked", "dropEventResponses", "rateLimitNext", "unavailableNext", "eventDelayMs", "serverLearningDate"];

async function control(request, response, url) {
  const tenant = url.searchParams.get("tenant");
  if (tenant === null) return failure(response, 400, "validation_error", "tenant is required.");
  if (url.pathname === "/__stub/reset") {
    tenants.set(tenant, freshState());
    return send(response, 200, { ok: true });
  }
  const state = stateOf(tenant);
  if (url.pathname === "/__stub/config" && request.method === "POST") {
    const body = await readBody(request);
    if (isRecord(body)) for (const key of APPLIED) if (key in body) state[key] = body[key];
    return send(response, 200, { ok: true });
  }
  if (url.pathname === "/__stub/state") {
    return send(response, 200, {
      acknowledged: [...state.acknowledged],
      pending: [...state.pendingIds],
      rejected: Object.fromEntries(state.rejected),
      eventLog: state.eventLog,
      batches: state.batches,
      duplicates: state.duplicates,
      completions: state.completions,
      onlineSessionId: state.onlineDaily?.sessionId ?? null,
      snapshots: state.snapshots.size,
      snapshotIds: [...state.snapshots.keys()],
      sessionIds: [...state.snapshots.values()].flatMap((snapshot) => snapshot.preparedSessions.map((session) => session.sessionId)),
      answerResults: state.answerResults,
      logoutCalls: state.logoutCalls,
      requests: state.requests,
      daily: dailyOf(state),
    });
  }
  return failure(response, 404, "not_found", "Not found.");
}

// Returns true when it took the request. The rest of the stub is left untouched.
export function handleOfflineStub(request, response) {
  const url = new URL(request.url ?? "/", "http://stub.invalid");
  if (url.pathname.startsWith("/__stub/")) {
    void control(request, response, url);
    return true;
  }
  if (!url.pathname.startsWith("/api/")) return false;
  const tenant = tenantOf(request, url);
  if (tenant === null) return false;
  const state = stateOf(tenant);
  state.requests.push(`${request.method} ${url.pathname}`);
  const path = url.pathname.slice("/api".length);

  if (request.method === "GET" && path === "/health") return false;
  if (request.method === "POST" && path === "/auth/logout") {
    state.logoutCalls += 1;
    state.signedIn = false;
    response.writeHead(204, { "Cache-Control": "no-store", "X-Stub-Backend": "1" });
    response.end();
    return true;
  }
  if (request.method === "POST" && path === "/auth/login") {
    // A synthetic sign-in for the account-switch spec: whoever logs in becomes the tenant's account.
    void (async () => {
      const body = await readBody(request);
      if (!isRecord(body) || typeof body.username !== "string") return failure(response, 422, "validation_error", "The request body is not valid.", { fields: [{ field: "username", rule: "invalid_type" }] });
      state.user = body.username.trim().toLowerCase();
      state.signedIn = true;
      state.me401 = false;
      return send(response, 200, { profile: profileOf(state), reconsentRequired: false });
    })();
    return true;
  }
  if (request.method === "POST" && path === "/account/delete") {
    void (async () => {
      await readBody(request);
      state.signedIn = false;
      response.writeHead(204, { "Cache-Control": "no-store", "X-Stub-Backend": "1" });
      response.end();
    })();
    return true;
  }
  const authenticated = state.signedIn && !state.me401;
  if (request.method === "GET" && path === "/me") {
    if (!authenticated) failure(response, 401, "unauthenticated", "Authentication is required.");
    else send(response, 200, profileOf(state));
    return true;
  }
  if (request.method === "GET" && path === "/today") {
    if (!authenticated) failure(response, 401, "unauthenticated", "Authentication is required.");
    else send(response, 200, { ...today, learningDate: state.serverLearningDate, plan: { ...today.plan, currentVersion: state.planVersion, status: state.planActive ? "active" : "paused" } });
    return true;
  }

  const create = /^\/plans\/([^/]+)\/offline-snapshots$/.exec(path);
  const read = /^\/offline-snapshots\/([^/]+)$/.exec(path);
  const sessionEvents = /^\/sessions\/([^/]+)\/events$/.exec(path);
  const sessionComplete = /^\/sessions\/([^/]+)\/complete$/.exec(path);
  const dailyStart = request.method === "POST" && path === "/sessions";
  const offline = (request.method === "POST" && create !== null) || (request.method === "GET" && read !== null) || (request.method === "POST" && path === "/offline/revalidate");
  if (!offline && sessionEvents === null && sessionComplete === null && !dailyStart) return false;

  void (async () => {
    const body = request.method === "POST" ? await readBody(request) : undefined;
    if (!authenticated) return failure(response, 401, "unauthenticated", "Authentication is required.");
    if (dailyStart) return startDaily(state, response, body);
    if (sessionEvents !== null) {
      if (state.rateLimitNext > 0) {
        state.rateLimitNext -= 1;
        return failure(response, 429, "throttled", "Too many requests.", { retryAfterSec: 1 }, { "Retry-After": "1" });
      }
      if (state.unavailableNext > 0) {
        state.unavailableNext -= 1;
        return failure(response, 503, "unavailable", "The service is temporarily unavailable.");
      }
      return events(state, request, response, decodeURIComponent(sessionEvents[1]), body);
    }
    if (sessionComplete !== null) {
      const found = findSession(state, decodeURIComponent(sessionComplete[1]));
      if (found === null) return failure(response, 404, "not_found", "The session was not found.");
      state.completions.push({ sessionId: decodeURIComponent(sessionComplete[1]), key: request.headers["idempotency-key"] ?? null });
      return send(response, 200, { summary: { answered: state.answerResults.length, correct: state.answerResults.filter((entry) => entry.correct).length, newPassages: 0, reviewsPassed: 0, reviewsFailed: 0, activeMs: unionMs(state.intervals) }, daily: dailyOf(state) });
    }
    if (create !== null) return createSnapshot(state, response, decodeURIComponent(create[1]), body);
    if (read !== null) {
      const snapshot = state.snapshots.get(decodeURIComponent(read[1]));
      if (snapshot === undefined || state.revoked) return failure(response, 404, "not_found", "The snapshot was not found.");
      return send(response, 200, snapshot);
    }
    return revalidate(state, response, body);
  })();
  return true;
}

export { COOKIE as E2E_COOKIE, EDITION_ID };
