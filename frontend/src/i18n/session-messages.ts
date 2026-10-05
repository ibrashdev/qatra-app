// S-19 (memorization session) strings. Arabic is verbatim from docs/UI-screens.md S-19 and the G-codes it cites; English is proposed (UI-tokens A7).
// Kept out of messages.ts, which another package owns: the screen reads its catalog with sessionMessages(locale).
// Where the Arabic copy of the document holds a dash, the line is joined with a colon or a comma instead (antislop R-02, no dash in new text).
import { formatInteger } from "./format";
import type { Locale } from "./messages";

export interface SessionMessages {
  title: string; // c2, the H1 and the document title
  backDestination: string; // c1: the name after "Back to"
  pause: string; // c3
  stages: { label: string; review: string; fresh: string; test: string; done: string };
  line: { review: string; light: string; restart: string }; // c6, the step line
  learn: {
    heading: string;
    instruction: string;
    start: string;
    legend: string;
    hide: string;
    show: string;
    hiddenNote: string;
    hiddenAnnounce: string;
    shownAnnounce: string;
    textLabel: string;
    paths: { quran: string; matn: string; sanad: string; grade: string };
    takhrij: string;
    grade: string;
    notStated: string;
  };
  question: { counter: (k: number, n: number, locale: Locale) => string; streak: (count: number, goal: number, locale: Locale) => string; skipped: string };
  primary: { check: string; next: string; finish: string; finishing: string; retry: string };
  pauseSheet: { title: string; body: string; keepGoing: string; leave: string; saving: string; failed: string; retry: string };
  banners: { offlineQueue: string; planInactive: string; backToToday: string; tooLarge: string };
  empty: { text: string; action: string };
}

const ar: SessionMessages = {
  title: "جلسة الحفظ",
  backDestination: "اليوم",
  pause: "إيقاف",
  stages: { label: "مراحل الجلسة", review: "مراجعة", fresh: "جديد", test: "اختبار", done: "مكتملة" },
  line: {
    review: "نبدأ بمراجعة ما حفظته.",
    light: "نبدأ اليوم بمراجعة خفيفة.",
    restart: "نبدأ من أول الجلسة؛ إجاباتك السابقة محفوظة.",
  },
  learn: {
    heading: "مقطع جديد",
    instruction: "اقرأ المقطع، ثم جرّب الاسترجاع.",
    start: "ابدأ التدريب",
    legend: "المظلل هو مقطع اليوم.",
    hide: "إخفاء النص",
    show: "إظهار النص",
    hiddenNote: "النص مخفي للتسميع؛ اضغط «إظهار النص» لتراجعه.",
    hiddenAnnounce: "تم إخفاء النص",
    shownAnnounce: "تم إظهار النص",
    textLabel: "نص المقطع",
    paths: { quran: "القرآن", matn: "متن", sanad: "سند", grade: "الدرجة" },
    takhrij: "التخريج من سجل HadeethEnc:",
    grade: "الدرجة من سجل HadeethEnc:",
    notStated: "غير مذكور في النسخة",
  },
  question: {
    counter: (k, n, locale) => `سؤال ${formatInteger(locale, k)} من ${formatInteger(locale, n)}`,
    streak: (count, goal, locale) => `متتالية صحيحة: ${formatInteger(locale, count)} من ${formatInteger(locale, goal)}`,
    skipped: "تعذّر عرض هذا السؤال؛ ننتقل إلى التالي.",
  },
  primary: { check: "تحقق", next: "التالي", finish: "إنهاء الجلسة", finishing: "جارٍ إنهاء الجلسة…", retry: "إعادة المحاولة" },
  pauseSheet: {
    title: "الجلسة متوقفة مؤقتًا",
    body: "لا يُحتسب وقت التوقف. تستأنف من «اليوم» متى شئت.",
    keepGoing: "متابعة الجلسة",
    leave: "إيقاف مؤقت والخروج",
    saving: "جارٍ الحفظ…",
    failed: "تعذّر حفظ آخر نشاطك. حاول مرة أخرى قبل الخروج.",
    retry: "إعادة المحاولة",
  },
  banners: {
    offlineQueue: "لا يوجد اتصال بالشبكة. سنعيد المحاولة تلقائيًا، أو اضغط «إعادة المحاولة».",
    planInactive: "هذه الخطة غير نشطة.",
    backToToday: "العودة إلى اليوم",
    tooLarge: "تعذّر إرسال الطلب لأنه أكبر من الحد المسموح.",
  },
  empty: { text: "لا توجد أسئلة في هذه الجلسة اليوم.", action: "العودة إلى اليوم" },
};

const en: SessionMessages = {
  title: "Memorization session",
  backDestination: "Today",
  pause: "Pause",
  stages: { label: "Session steps", review: "Review", fresh: "New", test: "Test", done: "completed" },
  line: {
    review: "We start by reviewing what you memorized.",
    light: "Today we start with a light review.",
    restart: "We start from the beginning; your earlier answers are saved.",
  },
  learn: {
    heading: "New passage",
    instruction: "Read the passage, then try to recall it.",
    start: "Start practice",
    legend: "The highlighted part is today's passage.",
    hide: "Hide the text",
    show: "Show the text",
    hiddenNote: "The text is hidden for recall; press “Show the text” to see it again.",
    hiddenAnnounce: "The text is hidden",
    shownAnnounce: "The text is shown",
    textLabel: "Passage text",
    paths: { quran: "Quran", matn: "Matn", sanad: "Sanad", grade: "Grade" },
    takhrij: "Takhrij from the HadeethEnc record:",
    grade: "Grade from the HadeethEnc record:",
    notStated: "Not stated in the edition",
  },
  question: {
    counter: (k, n, locale) => `Question ${formatInteger(locale, k)} of ${formatInteger(locale, n)}`,
    streak: (count, goal, locale) => `Correct in a row: ${formatInteger(locale, count)} of ${formatInteger(locale, goal)}`,
    skipped: "This question could not be shown; moving on to the next one.",
  },
  primary: { check: "Check", next: "Next", finish: "Finish the session", finishing: "Finishing the session…", retry: "Try again" },
  pauseSheet: {
    title: "Session paused",
    body: "Paused time does not count. Resume from Today whenever you like.",
    keepGoing: "Continue the session",
    leave: "Pause and leave",
    saving: "Saving…",
    failed: "We could not save your latest activity. Try again before you leave.",
    retry: "Try again",
  },
  banners: {
    offlineQueue: "There is no network connection. We will try again automatically, or press “Try again”.",
    planInactive: "This plan is not active.",
    backToToday: "Back to Today",
    tooLarge: "The request could not be sent because it is larger than the allowed limit.",
  },
  empty: { text: "There are no questions in this session today.", action: "Back to Today" },
};

const CATALOGS: Record<Locale, SessionMessages> = { ar, en };

export function sessionMessages(locale: Locale): SessionMessages {
  return CATALOGS[locale];
}
