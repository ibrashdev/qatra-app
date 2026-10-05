// Mock handlers for E19 and E20 (`daily`), as the plan and today screen uses them. Synthetic data only. Registered by the coordinator next to
// mockHandlers: { ...mockHandlers, ...todayMockHandlers }. Only types come from handlers.ts, so the two files can import each other safely.
import type { ProgressResponse, SessionSnapshot } from "../types";
import { MOCK_PLAN_ID, MOCK_QURAN_EDITION_ID, mockToday, mockTodayWithoutPlan } from "./fixtures";
import type { MockHandler, MockResponse } from "./handlers";

export const MOCK_SESSION_ID = "55555555-5555-4555-8555-000000000001";

function failure(status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse {
  return { status, body: { error: { code, message, details } } };
}

const unauthenticated = (): MockResponse => failure(401, "unauthenticated", "Authentication is required.");

const { plan: mockPlan, ...mockDaily } = mockToday;

// The plan of the E18 fixture: two sections of 60 and 40 words, 24 words confirmed (24 of 100), the first section 40 %.
export const mockProgress: ProgressResponse = {
  daily: {
    learningDate: mockDaily.learningDate,
    dailyActiveMs: mockDaily.dailyActiveMs,
    dailyGoalMs: mockDaily.dailyGoalMs,
    dailyPercent: mockDaily.dailyPercent,
    dailyCompleted: mockDaily.dailyCompleted,
    extraActiveMs: mockDaily.extraActiveMs,
  },
  history: [{ date: "2026-10-04", activeMs: 660_000, goalMs: 600_000, completed: true }],
  plans: [
    {
      planId: MOCK_PLAN_ID,
      titleAr: "عنوان الكتاب (عنصر نائب)",
      titleEn: "Book title (placeholder)",
      status: "active",
      currentVersion: mockPlan?.currentVersion ?? 1,
      overallPercent: 24,
      confirmedWords: 24,
      totalWords: 100,
      confirmedSections: 0,
      totalSections: 2,
      counts: { new: 2, learning: 1, reviewing: 0, confirmed: 1, needsRefresh: 0 },
      nextReviewDate: "2026-10-06",
      sections: [
        { ordinal: 1, reference: "1", titleAr: "اسم القسم (عنصر نائب) ١", titleEn: "Section placeholder 1", percent: 40, status: "learning" },
        { ordinal: 2, reference: "2", titleAr: "اسم القسم (عنصر نائب) ٢", titleEn: "Section placeholder 2", percent: 0, status: "new" },
      ],
    },
  ],
};

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

const DAILY_FIELDS = ["kind", "planId", "expectedPlanVersion"] as const;

// E20 answers in the order of API-spec 4.7: the body shape, then the plan, then its state, then its version. Only `daily` is served here.
const createSession: MockHandler = ({ body }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const fields = asRecord(body);
  if (fields.kind !== "daily") {
    return failure(422, "validation_error", "The request body is not valid.", { fields: [{ field: "kind", rule: "kind_invalid" }] });
  }
  const unknown = Object.keys(fields).filter((field) => !(DAILY_FIELDS as readonly string[]).includes(field));
  if (unknown.length > 0 || typeof fields.planId !== "string" || typeof fields.expectedPlanVersion !== "number") {
    return failure(422, "validation_error", "The request body is not valid.", {
      fields: [...unknown.map((field) => ({ field, rule: "forbidden_field" })), ...DAILY_FIELDS.filter((field) => field !== "kind" && typeof fields[field] === "undefined").map((field) => ({ field, rule: "invalid_type" }))],
    });
  }
  if (fields.planId !== MOCK_PLAN_ID) return failure(404, "not_found", "The plan was not found.");
  if (!scenario.hasPlan || mockPlan === null) return failure(409, "version_conflict", "The plan is not active.", { reason: "plan_not_active" });
  if (fields.expectedPlanVersion !== mockPlan.currentVersion) {
    return failure(409, "version_conflict", "The plan was changed.", { reason: "plan_version", currentVersion: mockPlan.currentVersion });
  }
  // The snapshot is empty on purpose: the memorization screen (S-19) is not built, and no passage text is invented here.
  const snapshot: SessionSnapshot = {
    sessionId: MOCK_SESSION_ID,
    kind: "daily",
    planId: MOCK_PLAN_ID,
    planVersion: mockPlan.currentVersion,
    editionId: MOCK_QURAN_EDITION_ID,
    bankVersion: 1,
    learningDate: mockDaily.learningDate,
    status: "open",
    steps: [],
    createdAt: "2026-10-05T07:00:00Z",
  };
  return { status: 201, body: snapshot };
};

// Keys are "METHOD /path", like mockHandlers.
export const todayMockHandlers: Record<string, MockHandler> = {
  "GET /progress": (_request, scenario) => {
    if (!scenario.signedIn) return unauthenticated();
    if (scenario.hasPlan) return { status: 200, body: mockProgress };
    const answer: ProgressResponse = {
      daily: { ...mockProgress.daily, dailyActiveMs: mockTodayWithoutPlan.dailyActiveMs, dailyPercent: mockTodayWithoutPlan.dailyPercent },
      history: [],
      plans: [],
    };
    return { status: 200, body: answer };
  },
  "POST /sessions": createSession,
};
