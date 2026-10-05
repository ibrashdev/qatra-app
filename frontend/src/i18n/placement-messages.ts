// Strings of S-09, the placement test (UI-screens S-09 section 3). Arabic is verbatim from the table where it fixes the words; the English and the
// copy the table leaves open are proposed (UI-tokens A7).
import { formatInteger } from "./format";
import type { Locale } from "./messages";

export interface PlacementMessages {
  title: string; // c2, the H1
  backDestination: string; // c1
  skipTest: string; // c3
  intro: string; // c4
  rating: { legend: string; none: string; some: string; most: string; helper: string }; // c5, c6
  start: string; // c7
  creating: string; // E20 in flight
  progress: (k: number, n: number, locale: Locale) => string; // c8
  next: string; // c12
  finish: string; // c12 on the last question
  skipQuestion: string; // c14
  chooseOrSkip: string; // P-03
  done: { title: string; text: string; calm: string }; // c15 and the calm line
  continue: string; // c16
  preparing: string; // «جارٍ تجهيز المحادثة…»
  leave: { title: string; body: string; stay: string; exit: string };
  skip: { title: string; body: string; stay: string; confirm: string };
  editionUnavailable: string; // G-20
  questionsFailed: string; // E20 422 on the plan options
  conversationFailed: string; // E31 422 on the plan options
  editOptions: string;
}

export const placementAr: PlacementMessages = {
  title: "اختبار قصير",
  backDestination: "ما هي خطتك؟",
  skipTest: "تخطي الاختبار",
  intro: "أسئلة تذكر قصيرة، وليست تقييمًا للتلاوة. لا يُحتسب وقتها في هدفك اليومي.",
  rating: {
    legend: "ما مقدار ما تحفظه من هذا الكتاب الآن؟ (اختياري)",
    none: "لم أحفظ",
    some: "بعضه",
    most: "أغلبه",
    helper: "لا يؤثر هذا الاختيار في التقدير؛ تعتمد الخطة على إجاباتك.",
  },
  start: "ابدأ الاختبار",
  creating: "جارٍ تجهيز الأسئلة…",
  progress: (k, n, locale) => `السؤال ${formatInteger(locale, k)} من ${formatInteger(locale, n)}`,
  next: "التالي",
  finish: "إنهاء الاختبار",
  skipQuestion: "تجاوز السؤال",
  chooseOrSkip: "اختر إجابة أو اضغط «تجاوز السؤال».",
  done: {
    title: "انتهى الاختبار",
    text: "سنستخدم إجاباتك لتقدير نقطة البداية.",
    calm: "يعتمد التقدير على إجاباتك في الاختبار، ويمكنك تعديل الخطة في المحادثة.",
  },
  continue: "متابعة إلى الخطة",
  preparing: "جارٍ تجهيز المحادثة…",
  leave: {
    title: "الخروج من الاختبار؟",
    body: "تعود إلى اختيارات الخطة. لا يُحتسب وقت الاختبار في هدفك اليومي.",
    stay: "متابعة الاختبار",
    exit: "الخروج إلى اختيارات الخطة",
  },
  skip: {
    title: "تخطي الاختبار؟",
    body: "ستُبنى الخطة دون نتيجة اختبار، فيُقدَّر الزمن على أنك تبدأ من الصفر.",
    stay: "متابعة الاختبار",
    confirm: "تخطي والمتابعة إلى الخطة",
  },
  editionUnavailable: "هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.",
  questionsFailed: "تعذّر تجهيز الأسئلة بسبب خيارات الخطة. عدّلها ثم أعد المحاولة.",
  conversationFailed: "تعذّر بدء المحادثة بسبب خيارات الخطة. عدّلها ثم أعد المحاولة.",
  editOptions: "تعديل الخيارات",
};

export const placementEn: PlacementMessages = {
  title: "Short test",
  backDestination: "What is your plan?",
  skipTest: "Skip the test",
  intro: "Short recall questions, not a recitation assessment. Their time does not count toward your daily goal.",
  rating: {
    legend: "How much of this book do you already know? (optional)",
    none: "None",
    some: "Some",
    most: "Most",
    helper: "This choice does not affect the estimate; the plan relies on your answers.",
  },
  start: "Start the test",
  creating: "Preparing the questions…",
  progress: (k, n, locale) => `Question ${formatInteger(locale, k)} of ${formatInteger(locale, n)}`,
  next: "Next",
  finish: "Finish the test",
  skipQuestion: "Skip this question",
  chooseOrSkip: "Choose an answer or press “Skip this question”.",
  done: {
    title: "The test is finished",
    text: "We will use your answers to estimate your starting point.",
    calm: "The estimate relies on your answers, and you can adjust the plan in the conversation.",
  },
  continue: "Continue to the plan",
  preparing: "Preparing the conversation…",
  leave: {
    title: "Leave the test?",
    body: "You go back to the plan options. The test time does not count toward your daily goal.",
    stay: "Continue the test",
    exit: "Leave for the plan options",
  },
  skip: {
    title: "Skip the test?",
    body: "The plan is built without a test result, so time is estimated as if you start from zero.",
    stay: "Continue the test",
    confirm: "Skip and continue to the plan",
  },
  editionUnavailable: "This edition is no longer available. You can start a plan on another edition.",
  questionsFailed: "The questions could not be prepared because of the plan options. Change them and try again.",
  conversationFailed: "The conversation could not start because of the plan options. Change them and try again.",
  editOptions: "Change the options",
};

export function placementMessages(locale: Locale): PlacementMessages {
  return locale === "ar" ? placementAr : placementEn;
}
