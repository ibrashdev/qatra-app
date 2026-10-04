// Synthetic data only: placeholders, fake ids, no source text and no real book, learner or account data.
import type { CatalogResponse, Profile, Today } from "../types";

export const MOCK_QURAN_EDITION_ID = "11111111-1111-4111-8111-0000000000e1";
export const MOCK_HADITH_EDITION_ID = "11111111-1111-4111-8111-0000000000e2";
export const MOCK_PLAN_ID = "44444444-4444-4444-8444-000000000001";

export const mockProfile: Profile = {
  username: "sample_user_01",
  language: "ar",
  timeZone: "Asia/Dubai",
  sessionMinutes: 10,
  reminderSettings: { inApp: true },
  isDemo: false,
  termsVersion: "2026-10-04",
  termsAcceptedAt: "2026-10-04T08:15:00Z",
  createdAt: "2026-10-04T08:15:00Z",
  pendingSettings: null,
};

// The password the mock accepts for the synthetic accounts below: the example of API-spec 4.2, not a real secret.
export const MOCK_PASSWORD = "synthetic passphrase for docs only";

export type MockLoginOutcome = "ok" | "ok_no_plan" | "reconsent" | "throttled" | "locked" | "unavailable" | "internal" | "origin";

// Sign-in names that make the mock answer each documented outcome of E04 (API-spec 4.2). No real account exists behind any of them.
// The first three need MOCK_PASSWORD; the failure names answer the same whatever the password is. Any other name is invalid_credentials.
export const MOCK_LOGINS: ReadonlyMap<string, MockLoginOutcome> = new Map<string, MockLoginOutcome>([
  ["sample_user_01", "ok"],
  ["new_user_01", "ok_no_plan"],
  ["reconsent_user_01", "reconsent"],
  ["throttled_user_01", "throttled"],
  ["locked_user_01", "locked"],
  ["unavailable_user_01", "unavailable"],
  ["internal_user_01", "internal"],
  ["origin_user_01", "origin"],
]);

export const mockCatalog: CatalogResponse = {
  editions: [
    {
      editionId: MOCK_QURAN_EDITION_ID,
      editionKey: "placeholder-quran-edition",
      titleAr: "عنوان الكتاب (عنصر نائب)",
      titleEn: "Book title (placeholder)",
      author: "اسم المؤلف (عنصر نائب)",
      editionLabel: "تسمية الطبعة (عنصر نائب)",
      category: { slug: "placeholder-quran", labelAr: "اسم الباب (عنصر نائب)", labelEn: "Category (placeholder)" },
      catalogVersion: 1,
      contentFormat: "quran",
      availablePaths: ["quran"],
      defaultPaths: ["quran"],
      defaultOrder: "book",
      totalWords: 100,
      sections: [
        {
          sectionId: "22222222-2222-4222-8222-000000000001",
          ordinal: 1,
          kind: "surah",
          reference: "1",
          titleAr: "اسم القسم (عنصر نائب) ١",
          titleEn: "Section placeholder 1",
          wordCount: 60,
          passageCount: 2,
          paths: ["quran"],
        },
        {
          sectionId: "22222222-2222-4222-8222-000000000002",
          ordinal: 2,
          kind: "surah",
          reference: "2",
          titleAr: "اسم القسم (عنصر نائب) ٢",
          titleEn: "Section placeholder 2",
          wordCount: 40,
          passageCount: 2,
          paths: ["quran"],
        },
      ],
    },
    {
      editionId: MOCK_HADITH_EDITION_ID,
      editionKey: "placeholder-hadith-edition",
      titleAr: "عنوان المجموعة (عنصر نائب)",
      titleEn: "Collection title (placeholder)",
      author: "اسم المؤلف (عنصر نائب)",
      editionLabel: "تسمية الطبعة (عنصر نائب)",
      category: { slug: "placeholder-hadith", labelAr: "اسم الباب (عنصر نائب)", labelEn: "Category (placeholder)" },
      catalogVersion: 1,
      contentFormat: "hadith_collection",
      availablePaths: ["matn", "sanad", "grade"],
      defaultPaths: ["matn"],
      defaultOrder: "book",
      totalWords: 30,
      sections: [
        {
          sectionId: "22222222-2222-4222-8222-000000000011",
          ordinal: 1,
          kind: "hadith",
          reference: "1",
          titleAr: "اسم القسم (عنصر نائب) ١",
          titleEn: "Section placeholder 1",
          wordCount: 30,
          passageCount: 1,
          paths: ["matn", "sanad", "grade"],
        },
      ],
    },
  ],
};

export const mockToday: Today = {
  learningDate: "2026-10-05",
  dailyActiveMs: 420_000,
  dailyGoalMs: 600_000,
  dailyPercent: 70,
  dailyCompleted: false,
  extraActiveMs: 0,
  plan: {
    planId: MOCK_PLAN_ID,
    editionId: MOCK_QURAN_EDITION_ID,
    titleAr: "عنوان الكتاب (عنصر نائب)",
    titleEn: "Book title (placeholder)",
    targetScope: { sectionOrdinals: [1, 2] },
    paths: ["quran"],
    order: "book",
    sessionMinutes: 10,
    preferredDate: "2026-10-20",
    agreedEstimate: {
      days: 16,
      endDate: "2026-10-20",
      newWordsPerDay: 25,
      totalWords: 100,
      knownWords: 0,
      passageCount: 4,
      sessionMinutes: 10,
      scope: { sectionOrdinals: [1, 2] },
      paths: ["quran"],
    },
    currentVersion: 1,
    status: "active",
    createdAt: "2026-10-04T08:30:00Z",
    planner: { source: "rules" },
  },
  dueReviews: 2,
  nextNewPassage: { reference: "1", sectionTitleAr: "اسم القسم (عنصر نائب) ١" },
  openSessionId: null,
  streakDays: 3,
  openPlanChatId: null,
};

// The same day for an account with no active plan (G-24).
export const mockTodayWithoutPlan: Today = {
  ...mockToday,
  dailyActiveMs: 0,
  dailyPercent: 0,
  plan: null,
  dueReviews: 0,
  nextNewPassage: null,
  streakDays: 0,
};
