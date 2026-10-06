// Synthetic plan snapshot of the e2e stub for the offline plan: placeholders and fake ids only, no source text and no real learner data.
// Shapes follow Implementation-contract section 7 (PlanSnapshot, SessionSnapshot, Question). It mirrors src/lib/api/mock/offline-handlers.ts, which a plain Node
// file cannot import. One daily descriptor (learn step, a choice question, a recall question) and one descriptor per game template, two questions each.

const POLICY = { normalizationPolicyVersion: "arabic-norm-v1", scoringPolicyVersion: "v1" };
const SOURCE = { publisher: "ناشر اصطناعي", editionLabel: "نسخة اصطناعية", bookTitleAr: "كتاب اصطناعي", reference: "1:1", url: "https://example.invalid/ref/1", pages: [] };

export const EDITION_ID = "11111111-1111-4111-8111-0000000000e1";
export const BANK_VERSION = 1;

// A UUID that is stable per (kind, position), so a repeated download builds the same ids.
const id = (kind, position) => `eeeeeeee-eeee-4eee-8eee-${kind}${String(position).padStart(12 - kind.length, "0")}`;
const passageId = (position) => `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${position}`;

const base = { reviewRoundId: null, policy: POLICY, source: SOURCE, context: { before: [{ ref: "1:0", text: "كلمة١" }], after: [{ ref: "1:9", text: "كلمة٩" }] } };

function choice(kind, position, passage, variant = "word") {
  return {
    ...base,
    questionId: id(kind, position),
    type: "word_choice",
    variant,
    passageId: passageId(passage),
    role: "game",
    options: [
      { optionId: `${kind}${position}-a`, text: `كلمة${position}أ` },
      { optionId: `${kind}${position}-b`, text: `كلمة${position}ب` },
      { optionId: `${kind}${position}-c`, text: `كلمة${position}ج` },
    ],
    answerKey: { optionId: `${kind}${position}-a` },
  };
}

function similar(position, passage) {
  return {
    ...base,
    questionId: id("c3", position),
    type: "similar_distinction",
    passageId: passageId(passage),
    role: "game",
    options: [
      { optionId: `sim${position}-a`, text: `متشابه${position}أ` },
      { optionId: `sim${position}-b`, text: `متشابه${position}ب` },
    ],
    answerKey: { optionId: `sim${position}-a` },
  };
}

function order(position, passage) {
  return {
    ...base,
    questionId: id("c1", position),
    type: "word_order",
    passageId: passageId(passage),
    role: "game",
    tokens: [
      { ref: `${position}:3`, text: "كلمة٤" },
      { ref: `${position}:1`, text: "كلمة٢" },
      { ref: `${position}:2`, text: "كلمة٣" },
    ],
    answerKey: { order: [`${position}:1`, `${position}:2`, `${position}:3`] },
  };
}

// The answer key holds the arabic-norm-v1 form of "كلمة٦" (ta marbuta to ha, Arabic-Indic digit to its Western digit).
export const RECALL_WORD = "كلمة٦";
export const RECALL_NORM = "كلمه6";

function recall(position, passage) {
  return {
    ...base,
    questionId: id("c4", position),
    type: "word_recall",
    passageId: passageId(passage),
    role: "game",
    hintFirstLetter: "ك",
    answerKey: { acceptedNorms: [RECALL_NORM] },
  };
}

const lesson = (position) => ({
  passageId: passageId(position),
  path: "quran",
  reference: `${position}:1-2`,
  sectionTitleAr: `اسم القسم (عنصر نائب) ${position}`,
  units: [
    { unitRef: 1, kind: "ayah", reference: `${position}:1`, text: "كلمة١ كلمة٢ كلمة٣ كلمة٤" },
    { unitRef: 2, kind: "ayah", reference: `${position}:2`, text: "كلمة٥ كلمة٦ كلمة٧ كلمة٨" },
  ],
  highlight: { startRef: `${position}:1`, endRef: `${position}:2` },
  takhrij: null,
  grade: null,
  showD50Notice: false,
  source: SOURCE,
});

export const GAME_KINDS = ["word_order", "word_choice", "similar_distinction", "word_recall"];

function gameQuestions(kind) {
  switch (kind) {
    case "word_order":
      return [order(1, 1), order(2, 2)];
    case "word_choice":
      return [choice("c2", 1, 1), choice("c2", 2, 2, "segment")];
    case "similar_distinction":
      return [similar(1, 1), similar(2, 2)];
    default:
      return [recall(1, 1), recall(2, 2)];
  }
}

const dailyQuestions = () => [choice("d1", 1, 1), recall(9, 1)];

// The snapshot a tenant gets for one E23 call. `serial` makes ids unique per snapshot (a new download is a new snapshot), `userId` is the ownership binding.
export function buildSnapshot({ snapshotId, planId, planVersion, userId, serial, learningDate, dailyGoalMs }) {
  const session = (sessionId, kind, steps) => ({ sessionId, kind, planId, planVersion, editionId: EDITION_ID, bankVersion: BANK_VERSION, learningDate, status: "prepared", steps, createdAt: new Date().toISOString() });
  const lessons = [lesson(1), lesson(2)];
  const dailySteps = [{ type: "learn", passage: lessons[0] }, ...dailyQuestions().map((question) => ({ type: "question", question }))];
  const sessions = [session(id("a1", serial), "daily", dailySteps)];
  GAME_KINDS.forEach((kind, position) => {
    sessions.push(session(id("a2", serial * 10 + position + 1), "game", gameQuestions(kind).map((question) => ({ type: "question", question }))));
  });
  return {
    snapshotId,
    schemaVersion: 1,
    protocolVersion: 1,
    userId,
    planId,
    planVersion,
    editionId: EDITION_ID,
    bankVersion: BANK_VERSION,
    targetScope: { sectionOrdinals: [1, 2] },
    downloadedTargetRefs: lessons.map((entry) => entry.passageId),
    learningTimeZone: "Asia/Dubai",
    dailyGoalMs,
    contentHashes: {},
    verifiedAt: new Date().toISOString(),
    contentValidity: { checkedAt: new Date().toISOString(), result: "valid" },
    normalizationPolicyVersion: "arabic-norm-v1",
    scoringPolicyVersion: "v1",
    preparedSessions: sessions,
    lessons,
    games: GAME_KINDS.flatMap((kind) => gameQuestions(kind)),
    references: [SOURCE],
  };
}

export const snapshotId = (serial) => id("f0", serial);
export const userIdOf = (username) => {
  let hash = 0;
  for (const char of username) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_000_000;
  return `cccccccc-cccc-4ccc-8ccc-${String(hash).padStart(12, "0")}`;
};
