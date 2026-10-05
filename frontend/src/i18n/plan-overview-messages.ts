// S-12 (plan overview) strings. Arabic is verbatim from docs/UI-screens.md S-12 and the G-codes it cites; English is proposed (UI-tokens A7).
// The failure lines are shared with S-13 (plan-revise-messages.ts). Labels that S-11 already owns come from today-messages.ts.
import type { PlanOrder } from "@/lib/api/types";
import type { Locale } from "./messages";

export interface PlanOverviewMessages {
  screenName: string; // c2, the H1 and the document title
  backDestination: string; // c1, the destination the back control names
  sections: { goal: string; totalTime: string; dailyTime: string; stages: string; reviews: string; nextStep: string };
  goal: {
    titleEdition: (title: string, edition: string) => string;
    paths: (labels: string) => string;
    order: Record<PlanOrder, string>;
    date: (formatted: string) => string;
    noDate: string;
    separator: string; // between the parts of the scope line
  };
  totalTime: (days: number, formattedDays: string, endDate: string) => string; // c4
  stages: { summary: (count: string) => string; currentIn: string; current: string; percent: (formatted: string) => string };
  reviews: { rhythm: string };
  next: { passage: string; review: (date: string) => string; none: string }; // passage has {section} and {reference}
  buttons: { revise: string; startAnother: string };
  others: { heading: string; paused: string; completed: string; pausedLine: string; completedLine: string; resume: string; resuming: string; percent: (formatted: string) => string };
  resumeDialog: { title: string; body: string; confirm: string; cancel: string }; // body has {title}
  resumed: string; // the toast
  failure: { forbidden: string; notFound: string; notActive: string; notActiveCompleted: string; estimateChanged: string };
}

const ARABIC_PLURALS = new Intl.PluralRules("ar");

// «يوم واحد»، «يومين»، «٣ أيام»، «١٦ يومًا»; the English noun follows the count. Shared with S-13, which prints the same estimate.
export function daysPhrase(locale: Locale, days: number, formatted: string): string {
  if (locale === "en") return days === 1 ? "1 day" : `${formatted} days`;
  switch (ARABIC_PLURALS.select(days)) {
    case "one":
      return "يوم واحد";
    case "two":
      return "يومين";
    case "few":
      return `${formatted} أيام`;
    default:
      return `${formatted} يومًا`;
  }
}

const ar: PlanOverviewMessages = {
  screenName: "الخطة الكبرى",
  backDestination: "اليوم",
  sections: { goal: "الهدف الكلي", totalTime: "الزمن الكلي", dailyTime: "الزمن اليومي", stages: "المراحل", reviews: "المراجعات", nextStep: "الخطوة التالية" },
  goal: {
    titleEdition: (title, edition) => `${title} · ${edition}`,
    paths: (labels) => `المسارات: ${labels}`,
    order: { book: "ترتيب الكتاب", reverse: "من الناس رجوعًا" },
    date: (formatted) => `الموعد المفضل: ${formatted}`,
    noDate: "دون موعد محدد",
    separator: "؛ ",
  },
  totalTime: (days, formattedDays, endDate) => `التقدير المتفق عليه: نحو ${daysPhrase("ar", days, formattedDays)}، حتى ${endDate}.`,
  stages: {
    summary: (count) => `المراحل (${count})`,
    currentIn: "المرحلة الحالية: {title}",
    current: "الحالية",
    percent: (formatted) => `${formatted}٪`,
  },
  reviews: { rhythm: "تُراجَع كل مقطع بعد يوم، ثم بعد يومين، ثم بعد ٤ أيام؛ وما فاتك يبقى مستحقًا دون عقوبة. بعد التأكيد تستمر مراجعات الصيانة بفواصل أطول." },
  next: {
    passage: "المقطع التالي: {section} ({reference}).",
    review: (date) => `المراجعة التالية: ${date}.`,
    none: "لا مقاطع جديدة؛ تستمر مراجعات الصيانة.",
  },
  buttons: { revise: "تعديل الوقت والهدف", startAnother: "بدء خطة أخرى" },
  others: {
    heading: "خطط أخرى",
    paused: "متوقفة مؤقتًا",
    completed: "مكتملة",
    pausedLine: "هذه الخطة متوقفة مؤقتًا، وتقدمها محفوظ.",
    completedLine: "اكتملت هذه الخطة، وتستمر مراجعات الصيانة.",
    resume: "استئناف",
    resuming: "جارٍ الاستئناف…",
    percent: (formatted) => `${formatted}٪`,
  },
  resumeDialog: {
    title: "استئناف هذه الخطة؟",
    body: "ستتوقف خطتك الحالية «{title}» مؤقتًا ويبقى تقدمها محفوظًا، وتستأنف هذه الخطة من حيث توقفت.",
    confirm: "استئناف الخطة",
    cancel: "إلغاء",
  },
  resumed: "تم استئناف الخطة.",
  failure: {
    forbidden: "هذا الإجراء غير متاح لحساب العرض.",
    notFound: "لم نعثر على هذا العنصر.",
    notActive: "هذه الخطة غير نشطة.",
    notActiveCompleted: "اكتملت هذه الخطة؛ لا يمكن تعديلها أو استئنافها.",
    estimateChanged: "تغيّر التقدير. راجع التقدير الجديد ثم أكّد.",
  },
};

const en: PlanOverviewMessages = {
  screenName: "Overall plan",
  backDestination: "Today",
  sections: { goal: "Overall goal", totalTime: "Overall time", dailyTime: "Daily time", stages: "Stages", reviews: "Reviews", nextStep: "Next step" },
  goal: {
    titleEdition: (title, edition) => `${title} · ${edition}`,
    paths: (labels) => `Paths: ${labels}`,
    order: { book: "Book order", reverse: "From An-Nas backwards" },
    date: (formatted) => `Preferred date: ${formatted}`,
    noDate: "No set date",
    separator: "; ",
  },
  totalTime: (days, formattedDays, endDate) => `Agreed estimate: about ${daysPhrase("en", days, formattedDays)}, until ${endDate}.`,
  stages: {
    summary: (count) => `Stages (${count})`,
    currentIn: "Current stage: {title}",
    current: "Current",
    percent: (formatted) => `${formatted}%`,
  },
  reviews: { rhythm: "Each passage is reviewed after 1, then 2, then 4 days; missed reviews stay due with no penalty. After confirmation, maintenance reviews continue at longer intervals." },
  next: {
    passage: "Next passage: {section} ({reference}).",
    review: (date) => `Next review: ${date}.`,
    none: "No new passages; maintenance reviews continue.",
  },
  buttons: { revise: "Change time and goal", startAnother: "Start another plan" },
  others: {
    heading: "Other plans",
    paused: "Paused",
    completed: "Completed",
    pausedLine: "This plan is paused, and its progress is kept.",
    completedLine: "This plan is complete, and maintenance reviews continue.",
    resume: "Resume",
    resuming: "Resuming…",
    percent: (formatted) => `${formatted}%`,
  },
  resumeDialog: {
    title: "Resume this plan?",
    body: "Your current plan “{title}” pauses with its progress kept, and this plan resumes where it stopped.",
    confirm: "Resume the plan",
    cancel: "Cancel",
  },
  resumed: "The plan was resumed.",
  failure: {
    forbidden: "This action is not available for a demo account.",
    notFound: "We could not find this item.",
    notActive: "This plan is not active.",
    notActiveCompleted: "This plan is completed; it cannot be changed or resumed.",
    estimateChanged: "The estimate changed. Review the new estimate, then confirm.",
  },
};

const CATALOGS: Record<Locale, PlanOverviewMessages> = { ar, en };

export function planOverviewMessages(locale: Locale): PlanOverviewMessages {
  return CATALOGS[locale];
}

