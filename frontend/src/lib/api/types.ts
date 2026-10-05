// Copied from docs/Implementation-contract.md section 7 (v1.6) and API-spec 4.10.1 (E31 to E34); a mismatch goes back to the coordinator, not into this file.
// Types only: the client validates the error envelope and the health answer, never the shape of a DTO.

export type ISODate = string; // YYYY-MM-DD, a learning date in the account time zone
export type ISODateTime = string; // RFC 3339 UTC
export type TokenRef = string; // "<unitOrdinal>:<tokenIndex>"
export type Path = "quran" | "matn" | "sanad" | "grade";
export type GameKind = "word_order" | "word_choice" | "word_recall" | "similar_distinction";
export type PlanOrder = "book" | "reverse"; // 'reverse' is valid for the Juz' Amma (Quran) edition only (D72)

export interface Profile {
  username: string;
  language: "ar" | "en";
  timeZone: string;
  sessionMinutes: 5 | 10 | 15;
  reminderSettings: { inApp: boolean };
  isDemo: boolean;
  termsVersion: string;
  termsAcceptedAt: ISODateTime;
  createdAt: ISODateTime;
  pendingSettings: { sessionMinutes?: 5 | 10 | 15; timeZone?: string; effectiveDate: ISODate } | null;
}

export interface CatalogSection {
  sectionId: string;
  ordinal: number;
  kind: "surah" | "hadith";
  reference: string;
  titleAr: string;
  titleEn: string;
  wordCount: number;
  passageCount: number;
  paths: Path[];
}

export interface CatalogEdition {
  editionId: string;
  editionKey: string;
  titleAr: string;
  titleEn: string;
  author: string;
  editionLabel: string;
  category: { slug: string; labelAr: string; labelEn: string };
  catalogVersion: number;
  contentFormat: "quran" | "hadith_collection";
  availablePaths: Path[];
  defaultPaths: Path[];
  defaultOrder: PlanOrder; // always 'book'; 'reverse' is offered only when contentFormat is 'quran' (D72)
  totalWords: number;
  sections: CatalogSection[];
}

export interface TargetScope {
  sectionOrdinals: number[];
}

export interface Estimate {
  days: number;
  endDate: ISODate;
  newWordsPerDay: number;
  totalWords: number;
  knownWords: number;
  passageCount: number;
  sessionMinutes: 5 | 10 | 15;
  scope: TargetScope;
  paths: Path[];
}

export interface Plan {
  planId: string;
  editionId: string;
  titleAr: string;
  titleEn: string;
  targetScope: TargetScope;
  paths: Path[];
  order: PlanOrder;
  sessionMinutes: 5 | 10 | 15;
  preferredDate: ISODate | null;
  agreedEstimate: Estimate;
  currentVersion: number;
  status: "active" | "paused" | "completed";
  createdAt: ISODateTime;
  pendingSessionMinutes?: 5 | 10 | 15 | null; // plan-level change effective the next learning day (A-07, D57)
  planner: { source: "rules" | "teaching_agent"; model?: string };
}

export interface DailyProgress {
  learningDate: ISODate;
  dailyActiveMs: number;
  dailyGoalMs: number;
  dailyPercent: number;
  dailyCompleted: boolean;
  extraActiveMs: number;
}

export interface Today extends DailyProgress {
  plan: Plan | null;
  dueReviews: number;
  nextNewPassage: { reference: string; sectionTitleAr: string } | null;
  openSessionId: string | null;
  streakDays: number;
  openPlanChatId?: string | null; // the open plan conversation, lets S-08 and S-11 resume it (D75)
}

export interface PlanProgress {
  planId: string;
  titleAr: string;
  titleEn: string;
  status: Plan["status"];
  currentVersion: number; // lets a completed plan open an E20 daily session (O-32, UG-04)
  overallPercent: number;
  confirmedWords: number;
  totalWords: number;
  confirmedSections: number;
  totalSections: number;
  counts: { new: number; learning: number; reviewing: number; confirmed: number; needsRefresh: number };
  nextReviewDate: ISODate | null;
  sections: {
    ordinal: number;
    reference: string;
    titleAr: string;
    titleEn: string;
    percent: number;
    status: "new" | "learning" | "reviewing" | "confirmed" | "needs_refresh";
  }[];
}

export interface ProgressResponse {
  daily: DailyProgress;
  history: { date: ISODate; activeMs: number; goalMs: number; completed: boolean }[];
  plans: PlanProgress[];
}

export interface TokenView {
  ref: TokenRef;
  text: string;
}

export interface SourceRef {
  publisher: string;
  editionLabel: string;
  bookTitleAr: string;
  reference: string;
  url: string;
  pages: string[]; // empty for web editions; the url is always shown
}

export interface PassageView {
  passageId: string;
  path: Path;
  reference: string;
  sectionTitleAr: string;
  units: { unitRef: number; kind: "ayah" | "hadith_narration" | "hadith_grade"; reference: string; text: string }[]; // verbatim; a grade passage lies inside the hadith_grade unit
  highlight: { startRef: TokenRef; endRef: TokenRef }; // the passage range inside the units
  takhrij: string | null;
  grade: string | null;
  showD50Notice: boolean;
  source: SourceRef;
}

export interface QuestionBase {
  questionId: string;
  type: GameKind;
  passageId: string;
  role: "training" | "review" | "test" | "placement" | "game";
  reviewRoundId: string | null;
  context: { before: TokenView[]; after: TokenView[] };
  policy: { normalizationPolicyVersion: "arabic-norm-v1"; scoringPolicyVersion: "v1" };
  source: SourceRef;
}

export interface WordOrderQuestion extends QuestionBase {
  type: "word_order";
  tokens: TokenView[]; // shuffled
  answerKey: { order: TokenRef[] };
}

export interface ChoiceOption {
  optionId: string;
  text: string;
}

export interface WordChoiceQuestion extends QuestionBase {
  type: "word_choice";
  variant: "word" | "segment";
  options: ChoiceOption[];
  answerKey: { optionId: string };
}

export interface SimilarQuestion extends QuestionBase {
  type: "similar_distinction";
  options: ChoiceOption[];
  answerKey: { optionId: string };
}

export interface RecallQuestion extends QuestionBase {
  type: "word_recall";
  hintFirstLetter: string;
  answerKey: { acceptedNorms: string[] };
}

export type Question = WordOrderQuestion | WordChoiceQuestion | SimilarQuestion | RecallQuestion;

export type Step = { type: "learn"; passage: PassageView } | { type: "question"; question: Question };

export interface SessionSnapshot {
  sessionId: string;
  kind: "daily" | "game" | "placement";
  planId: string | null;
  planVersion: number | null;
  editionId: string;
  bankVersion: number;
  learningDate: ISODate;
  status: "prepared" | "open" | "completed";
  steps: Step[];
  createdAt: ISODateTime;
}

export type AnswerPayload = { order: TokenRef[] } | { optionId: string } | { text: string };

// Replay envelope of an event recorded offline (PWA-design 5): all fields or none; localSequence is ordering input, never a trusted clock.
export interface OfflineEnvelope {
  clientRunId: string;
  snapshotId: string;
  protocolVersion: 1;
  planVersion: number;
  editionId: string;
  bankVersion: number;
  normalizationPolicyVersion: "arabic-norm-v1";
  scoringPolicyVersion: "v1";
  localSequence: number;
}

export type SessionEvent = (
  | {
      clientEventId: string;
      type: "answer";
      questionId: string;
      answer: AnswerPayload;
      hintUsed: boolean;
      occurredAt: ISODateTime;
      durationMs: number;
    }
  | { clientEventId: string; type: "activity"; startedAt: ISODateTime; endedAt: ISODateTime; activeMs: number }
) &
  Partial<OfflineEnvelope>;

export interface AnswerResult {
  clientEventId: string;
  questionId: string;
  correct: boolean;
  assisted: boolean;
  expected: { order?: TokenRef[]; optionId?: string; word?: string };
  passage: {
    passageId: string;
    status: "new" | "learning" | "reviewing" | "confirmed" | "needs_refresh";
    coveredParts: number;
    totalParts: number;
    consecutiveCorrect: number;
  };
}

export interface EventsResponse {
  acknowledged: string[];
  duplicate: string[]; // the same clientEventId was acknowledged earlier
  pending: { clientEventId: string; reasonCode: string }[]; // disputed or unverifiable: kept without credit (D59)
  rejected: { clientEventId: string; code: string }[];
  results: AnswerResult[];
  daily: DailyProgress;
}

// Value sets of the string codes above (contract O-21, approved D74).
export type RejectedEventCode =
  | "question_not_in_session"
  | "out_of_scope"
  | "edition_mismatch"
  | "bank_version_mismatch"
  | "invalid_answer_shape"
  | "activity_out_of_bounds"
  | "plan_not_active"
  | "session_closed"
  | "envelope_mismatch";
export type PendingReasonCode =
  | "plan_changed_unverifiable"
  | "content_unverifiable"
  | "policy_unsupported"
  | "clock_unverifiable";
export type RevalidationReasonCode =
  | "current"
  | "plan_version_changed"
  | "bank_version_changed"
  | "content_revoked"
  | "validity_ended";

export interface CompleteResponse {
  summary: {
    answered: number;
    correct: number;
    newPassages: number;
    reviewsPassed: number;
    reviewsFailed: number;
    activeMs: number;
  };
  daily: DailyProgress;
}

export interface PlanSnapshot {
  snapshotId: string;
  schemaVersion: 1;
  protocolVersion: 1;
  userId: string; // owner binding: a non-secret ownership id, not a credential
  planId: string;
  planVersion: number;
  editionId: string;
  bankVersion: number;
  targetScope: TargetScope;
  downloadedTargetRefs: string[]; // the accepted downloadTargetRefs (passage ids, D66)
  learningTimeZone: string;
  dailyGoalMs: number;
  contentHashes: Record<string, string>; // NR: sha256 per downloaded content part, keying and chunking open
  verifiedAt: ISODateTime; // NR: when the server last verified the snapshot
  contentValidity: Record<string, unknown>; // NR: last server validity and rights check, not a lease or an expiry
  normalizationPolicyVersion: "arabic-norm-v1";
  scoringPolicyVersion: "v1";
  preparedSessions: SessionSnapshot[]; // status 'prepared', each with its server-owned sessionId
  lessons: PassageView[]; // verbatim text with edition, pages and source reference
  games: Question[]; // NR: question descriptors, all options and distractors needed offline
  references: SourceRef[];
}

export type OfflineStatus = "available" | "stale" | "revoked" | "expired";

export interface RevalidationResult {
  status: OfflineStatus;
  currentPlanVersion: number;
  allowedSessionRefs: string[];
  catalogVersion: number;
  reasonCode: string;
}

// Plan conversation (E31 to E34, D75). The server builds PlanSections from templates; numbers never come from the model.

export type QuickReplyCode =
  | "fewer_minutes"
  | "more_minutes"
  | "smaller_scope"
  | "later_date"
  | "no_date"
  | "order_book"
  | "order_reverse"
  | "paths_matn_only"
  | "paths_all"
  | "confirm";

export interface QuickReply {
  code: QuickReplyCode;
  labelAr: string;
  labelEn: string;
}

export interface PlanSections {
  goal: string;
  totalTime: string;
  dailyTime: string;
  stages: string;
  reviews: string;
  nextStep: string;
}

export interface PlanProposal {
  proposalVersion: number;
  editionId: string;
  targetScope: TargetScope;
  paths: Path[];
  order: PlanOrder;
  sessionMinutes: 5 | 10 | 15;
  preferredDate: ISODate | null;
  estimate: Estimate;
  sections: PlanSections;
}

export interface ChatMessage {
  messageId: string;
  ordinal: number;
  role: "learner" | "assistant";
  kind: "text" | "proposal" | "refusal" | "redirect" | "fallback" | "quick_reply";
  text: string;
  source: "learner" | "rules" | "model" | "fixed";
  createdAt: ISODateTime;
}

export interface PlanChat {
  chatId: string;
  status: "open" | "confirmed" | "abandoned";
  planId: string | null;
  language: "ar" | "en";
  messages: ChatMessage[];
  proposal: PlanProposal | null;
  quickReplies: QuickReply[];
  modelTurnsLeft: number;
  assistant: { source: "rules" | "model"; model?: string };
}

// E31 (API-spec 4.10.1). There is no `order` field: the Juz' Amma order is chosen in the conversation. `planId` makes it a revision.
export interface CreatePlanChatRequest {
  editionId: string;
  targetScope: TargetScope;
  paths: Path[];
  sessionMinutes: 5 | 10 | 15;
  preferredDate?: ISODate;
  placementSessionId?: string;
  goalText: string; // at most 500 characters after trimming; never logged
  language: "ar" | "en";
  planId?: string;
}

// E32: exactly one of the two. A `confirm` quick reply is E34, never E32.
export type PlanChatTurnRequest = { text: string; quickReply?: undefined } | { quickReply: Exclude<QuickReplyCode, "confirm">; text?: undefined };

// E34: must equal the conversation's current proposalVersion.
export interface ConfirmPlanChatRequest {
  proposalVersion: number;
}

// Not in the contract's TypeScript block: shapes taken from the endpoint table and API-spec 1.5.

export interface HealthResponse {
  status: "ok";
  version: string;
  time: ISODateTime;
}

export interface ReadyResponse {
  status: "ok";
}

// E04 (API-spec 4.2). The registration rules are not applied at login, so both fields are plain strings.
export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  profile: Profile;
  reconsentRequired: boolean;
}

// E03 (API-spec 4.2). `termsAccepted` is exactly true; `recoveryCode` is shown once and never retrievable again.
export interface RegisterRequest {
  username: string;
  password: string;
  timeZone: string; // IANA name from the browser
  language: "ar" | "en";
  termsAccepted: true;
  termsVersion: string;
}

export interface RegisterResponse {
  profile: Profile;
  recoveryCode: string; // 32 lowercase hex characters in eight groups of four joined by "-"
}

export interface CatalogResponse {
  editions: CatalogEdition[];
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
