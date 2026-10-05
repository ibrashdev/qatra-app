// Synthetic answers of the stub backend: placeholders and fake ids only, no source text and no real learner data.
// Shapes follow API-spec E14 (catalog), E18 (today) and E19 (progress); they mirror src/lib/api/mock/*.ts, which a plain Node file cannot import.

const QURAN_EDITION_ID = "11111111-1111-4111-8111-0000000000e1";
const PLAN_ID = "44444444-4444-4444-8444-000000000001";

export const catalog = {
  editions: [
    {
      editionId: QURAN_EDITION_ID,
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
  ],
};

const daily = {
  learningDate: "2026-10-05",
  dailyActiveMs: 420000,
  dailyGoalMs: 600000,
  dailyPercent: 70,
  dailyCompleted: false,
  extraActiveMs: 0,
};

export const today = {
  ...daily,
  plan: {
    planId: PLAN_ID,
    editionId: QURAN_EDITION_ID,
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

export const progress = {
  daily,
  history: [{ date: "2026-10-04", activeMs: 660000, goalMs: 600000, completed: true }],
  plans: [
    {
      planId: PLAN_ID,
      titleAr: "عنوان الكتاب (عنصر نائب)",
      titleEn: "Book title (placeholder)",
      status: "active",
      currentVersion: 1,
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
