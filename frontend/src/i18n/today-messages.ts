// S-11 (plan and today) strings. Arabic is verbatim from docs/UI-screens.md S-11 and the G-codes it cites; English is proposed (UI-tokens A7).
// Kept out of messages.ts, which another package owns: the screen reads its catalog with todayMessages(locale).
import type { Locale } from "./messages";

export interface TodayMessages {
  screenName: string; // c2, the H1 and the document title
  viewPlan: string; // c1
  goal: { label: string; withDate: string }; // c3; withDate has {title} and {date}
  daily: {
    label: string;
    text: (minutes: string, minutesCount: number, amount: string) => string; // c4; amount is the clause of dailyAmountText (whole ayat or hadith, D90)
    barLabel: string;
    unit: (count: number) => string; // the noun after the goal minutes
    percent: (formatted: string) => string;
    valueText: (done: string, goal: string, count: number, percent: string) => string; // aria-valuetext
    reached: string; // «أكملت هدف اليوم»
    extra: (formatted: string, count: number) => string;
    change: string;
  };
  stages: { label: string; current: string; percent: (formatted: string) => string; percentText: (formatted: string) => string };
  reviews: { label: string; due: (formatted: string) => string; none: string; next: (date: string) => string };
  next: {
    label: string;
    passage: string; // has {section} and {reference}
    nearHorizon: string;
    lightReview: string;
    start: string;
    continueSession: string;
    starting: string;
  };
  empty: { title: string; action: string; previousPlans: string }; // c8
  banners: { absence: string; pending: (date: string) => string; openChat: string; continueChat: string; completed: string };
  conflict: { planVersion: string; planNotActive: string; refresh: string };
  revoked: { label: string; text: string; startNew: string };
  loading: string;
  retry: string;
}

const ARABIC_PLURALS = new Intl.PluralRules("ar");
// The few form (3 to 10) takes the plural noun, every other count the singular.
const arabicNoun = (count: number, singular: string, plural: string): string => (ARABIC_PLURALS.select(count) === "few" ? plural : singular);

const ar: TodayMessages = {
  screenName: "خطوتك اليوم",
  viewPlan: "عرض الخطة",
  goal: { label: "الهدف الكلي", withDate: "{title} · الموعد {date}" },
  daily: {
    label: "الزمن اليومي",
    text: (minutes, minutesCount, amount) => `${minutes} ${arabicNoun(minutesCount, "دقيقة", "دقائق")} يوميًا، ${amount}`,
    barLabel: "الإنجاز اليومي",
    unit: (count) => arabicNoun(count, "دقيقة", "دقائق"),
    percent: (formatted) => `${formatted}٪`,
    valueText: (done, goal, count, percent) => `${done} من ${goal} ${arabicNoun(count, "دقيقة", "دقائق")}، ${percent} بالمئة`,
    reached: "أكملت هدف اليوم",
    extra: (formatted, count) => `+ ${formatted} ${arabicNoun(count, "دقيقة", "دقائق")} إضافية`,
    change: "تعديل الوقت والهدف",
  },
  stages: { label: "المراحل", current: "المرحلة الحالية", percent: (formatted) => `${formatted}٪`, percentText: (formatted) => `${formatted} بالمئة` },
  reviews: {
    label: "المراجعات",
    due: (formatted) => `مراجعات مستحقة اليوم: ${formatted}`,
    none: "لا توجد مراجعات مستحقة اليوم.",
    next: (date) => `موعد المراجعة التالي: ${date}`,
  },
  next: {
    label: "الخطوة التالية",
    passage: "المقطع الجديد التالي: {section} ({reference}).",
    nearHorizon: "لا توجد مقاطع جديدة؛ تتبقى المراجعات لتأكيد ما حفظته.",
    lightReview: "مراجعة خفيفة اليوم، دون مقاطع جديدة.",
    start: "ابدأ جلسة اليوم",
    continueSession: "تابع جلسة اليوم",
    starting: "جارٍ تجهيز الجلسة…",
  },
  empty: { title: "لا توجد خطة نشطة بعد.", action: "ابدأ خطتك", previousPlans: "الخطط السابقة" },
  banners: {
    absence: "نبدأ اليوم بمراجعة خفيفة.",
    pending: (date) => `يبدأ هذا التغيير من يوم التعلم التالي (${date}).`,
    openChat: "لديك محادثة خطة لم تعتمدها بعد.",
    continueChat: "متابعة المحادثة",
    completed: "اكتملت هذه الخطة، وتستمر مراجعات الصيانة.",
  },
  conflict: { planVersion: "عُدّلت خطتك في مكان آخر. حدّث الصفحة ثم أعد المحاولة.", planNotActive: "هذه الخطة غير نشطة.", refresh: "تحديث" },
  revoked: { label: "غير متاح", text: "هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.", startNew: "ابدأ خطة جديدة" },
  loading: "جارٍ التحميل",
  retry: "إعادة المحاولة",
};

const plural = (count: number, one: string, other: string): string => (count === 1 ? one : other);

const en: TodayMessages = {
  screenName: "Your step today",
  viewPlan: "View the plan",
  goal: { label: "Overall goal", withDate: "{title} · Target {date}" },
  daily: {
    label: "Daily time",
    text: (minutes, minutesCount, amount) => `${minutes} ${plural(minutesCount, "minute", "minutes")} a day, ${amount}`,
    barLabel: "Daily progress",
    unit: (count) => plural(count, "minute", "minutes"),
    percent: (formatted) => `${formatted}%`,
    valueText: (done, goal, count, percent) => `${done} of ${goal} ${plural(count, "minute", "minutes")}, ${percent} percent`,
    reached: "You reached today's goal",
    extra: (formatted, count) => `+ ${formatted} extra ${plural(count, "minute", "minutes")}`,
    change: "Change time and goal",
  },
  stages: { label: "Stages", current: "Current stage", percent: (formatted) => `${formatted}%`, percentText: (formatted) => `${formatted} percent` },
  reviews: {
    label: "Reviews",
    due: (formatted) => `Reviews due today: ${formatted}`,
    none: "No reviews are due today.",
    next: (date) => `Next review: ${date}`,
  },
  next: {
    label: "Next step",
    passage: "Next new passage: {section} ({reference}).",
    nearHorizon: "There are no new passages; the reviews that remain confirm what you have memorized.",
    lightReview: "A light review today, with no new passages.",
    start: "Start today's session",
    continueSession: "Continue today's session",
    starting: "Preparing the session…",
  },
  empty: { title: "No active plan yet.", action: "Start your plan", previousPlans: "Previous plans" },
  banners: {
    absence: "We start today with a light review.",
    pending: (date) => `This change starts on the next learning day (${date}).`,
    openChat: "You have a plan conversation you have not confirmed yet.",
    continueChat: "Continue the conversation",
    completed: "This plan is complete, and maintenance reviews continue.",
  },
  conflict: { planVersion: "Your plan was changed elsewhere. Refresh the page and try again.", planNotActive: "This plan is not active.", refresh: "Refresh" },
  revoked: { label: "Unavailable", text: "This edition is no longer available. You can start a plan on another edition.", startNew: "Start a new plan" },
  loading: "Loading",
  retry: "Try again",
};

const CATALOGS: Record<Locale, TodayMessages> = { ar, en };

export function todayMessages(locale: Locale): TodayMessages {
  return CATALOGS[locale];
}
