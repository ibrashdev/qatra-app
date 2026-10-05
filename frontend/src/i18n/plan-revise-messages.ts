// S-13 (plan revision) strings. Arabic is verbatim from docs/UI-screens.md S-13 and the G-codes it cites; English is proposed (UI-tokens A7).
// The failure lines come from plan-overview-messages.ts, the transparency line from plan-chat-messages.ts, the field labels shared with S-08 from
// start-messages.ts.
import type { Locale } from "./messages";

export interface PlanReviseMessages {
  screenName: string; // c2, the H1 and the document title
  backDestination: string; // c1
  explanation: string; // c4
  helper: { learner: string; demo: string }; // c5
  pausedNote: string; // a paused plan stays paused after the change
  start: { button: string; starting: string }; // c7
  backToPlan: string; // the button to S-12 beside a banner that closes the screen
  form: {
    reveal: string; // «تعديل بالنموذج» in the banner
    heading: string; // c8
    intro: string;
    minutes: string; // c9
    date: string; // c10
    dateHelper: string;
    paths: string; // c11
    pathsHelper: string;
    order: string; // c12
    calculate: string; // c13
    calculating: string;
    unchanged: string;
    confirm: string; // c15
    confirming: string;
  };
  preview: {
    heading: string;
    total: (daysText: string, endDate: string) => string;
    daily: (formattedMinutes: string, minutes: number, formattedWords: string, words: number) => string;
    next: string;
    exceeds: string;
    fits: string;
    shown: string; // the polite announcement
  };
  errors: { pathsInvalid: string; dateInvalid: string; orderNotAvailable: string; minutesInvalid: string };
  dialog: { title: string; body: string; paused: string; confirm: string; cancel: string };
}

const ARABIC_PLURALS = new Intl.PluralRules("ar");
// The few form (3 to 10) takes the plural noun, every other count the singular.
const arabicNoun = (count: number, singular: string, plural: string): string => (ARABIC_PLURALS.select(count) === "few" ? plural : singular);

const ar: PlanReviseMessages = {
  screenName: "تعديل الوقت والهدف",
  backDestination: "الخطة الكبرى",
  explanation: "تُعدَّل الخطة بالحديث مع المساعد: أقل دقائق، موعد أبعد، مسارات الحديث، أو ترتيب جزء عم. يسري التعديل من يوم التعلم التالي، ويبقى ما أنجزته كما هو.",
  helper: { learner: "يمكنك التعديل بالاختصارات وحدها دون كتابة نص حر.", demo: "في حساب العرض تُعدَّل الخطة بالخيارات الجاهزة فقط." },
  pausedNote: "تبقى الخطة متوقفة مؤقتًا بعد التعديل.",
  start: { button: "ابدأ التعديل مع المساعد", starting: "جارٍ تجهيز المحادثة…" },
  backToPlan: "العودة إلى الخطة الكبرى",
  form: {
    reveal: "تعديل بالنموذج",
    heading: "تعديل بالنموذج",
    intro: "المساعد غير متاح الآن. عدّل الخيارات هنا ثم راجع التقدير الجديد.",
    minutes: "وقتك اليومي",
    date: "الموعد المفضل (اختياري)",
    dateHelper: "اختياري. اتركه فارغًا إن لم يكن لديك موعد.",
    paths: "ما تريد تعلمه",
    pathsHelper: "يبقى مسار واحد على الأقل.",
    order: "ترتيب الخطة",
    calculate: "احسب التقدير",
    calculating: "جارٍ الحساب…",
    unchanged: "لم يتغير شيء بعد.",
    confirm: "اعتماد التعديل",
    confirming: "جارٍ الاعتماد…",
  },
  preview: {
    heading: "التقدير الجديد",
    total: (daysText, endDate) => `نحو ${daysText}، حتى ${endDate}`,
    daily: (minutes, minutesCount, words, wordsCount) => `${minutes} ${arabicNoun(minutesCount, "دقيقة", "دقائق")} يوميًا، وحتى ${words} ${arabicNoun(wordsCount, "كلمة", "كلمات")} جديدة`,
    next: "عند الاعتماد يسري التعديل من يوم التعلم التالي.",
    exceeds: "يتجاوز هذا التقدير موعدك المفضل. يمكنك اختيار وقت يومي أطول أو موعد أبعد.",
    fits: "يناسب هذا التقدير موعدك المفضل.",
    shown: "ظهر التقدير الجديد",
  },
  errors: {
    pathsInvalid: "اختر مسارًا واحدًا على الأقل.",
    dateInvalid: "اختر موعدًا من اليوم فصاعدًا.",
    orderNotAvailable: "هذا الترتيب غير متاح لهذا الكتاب.",
    minutesInvalid: "اختر ٥ أو ١٠ أو ١٥ دقيقة.",
  },
  dialog: {
    title: "اعتماد التعديل؟",
    body: "يسري هذا التعديل من يوم التعلم التالي. ما أنجزته اليوم يبقى كما هو، وتبقى أدلة الخطة السابقة محفوظة.",
    paused: "وتبقى الخطة متوقفة مؤقتًا.",
    confirm: "اعتماد التعديل",
    cancel: "إلغاء",
  },
};

const en: PlanReviseMessages = {
  screenName: "Change time and goal",
  backDestination: "Overall plan",
  explanation:
    "You change the plan by talking to the assistant: fewer minutes, a later date, hadith paths, or the Juz' Amma order. It takes effect from the next learning day and what you did stays.",
  helper: { learner: "You can make the change with the shortcuts alone, without typing free text.", demo: "In a demo account the plan is changed with the ready-made options only." },
  pausedNote: "The plan stays paused after the change.",
  start: { button: "Start the revision with the assistant", starting: "Preparing the conversation…" },
  backToPlan: "Back to the overall plan",
  form: {
    reveal: "Change with the form",
    heading: "Change with the form",
    intro: "The assistant is unavailable right now. Change the options here, then review the new estimate.",
    minutes: "Daily time",
    date: "Preferred date (optional)",
    dateHelper: "Optional. Leave it empty if you have no date.",
    paths: "What you want to learn",
    pathsHelper: "At least one path stays.",
    order: "Plan order",
    calculate: "Calculate the estimate",
    calculating: "Calculating…",
    unchanged: "Nothing has changed yet.",
    confirm: "Confirm the change",
    confirming: "Confirming…",
  },
  preview: {
    heading: "New estimate",
    total: (daysText, endDate) => `about ${daysText}, until ${endDate}`,
    daily: (minutes, minutesCount, words, wordsCount) =>
      `${minutes} ${minutesCount === 1 ? "minute" : "minutes"} a day, up to ${words} new ${wordsCount === 1 ? "word" : "words"}`,
    next: "On confirmation it takes effect from the next learning day.",
    exceeds: "This estimate goes past your preferred date. You can choose more daily time or a later date.",
    fits: "This estimate fits your preferred date.",
    shown: "The new estimate is shown",
  },
  errors: {
    pathsInvalid: "Choose at least one path.",
    dateInvalid: "Choose a date from today onwards.",
    orderNotAvailable: "This order is not available for this book.",
    minutesInvalid: "Choose 5, 10 or 15 minutes.",
  },
  dialog: {
    title: "Confirm the change?",
    body: "It takes effect from the next learning day. What you did today stays, and the evidence of the previous plan is kept.",
    paused: "The plan stays paused.",
    confirm: "Confirm the change",
    cancel: "Cancel",
  },
};

const CATALOGS: Record<Locale, PlanReviseMessages> = { ar, en };

export function planReviseMessages(locale: Locale): PlanReviseMessages {
  return CATALOGS[locale];
}
