// S-28, S-29 and S-30 (the demo path, option C, package F12) strings. The three screen names, the label «محسوبة سلفًا لا تشغيلًا حيًا» (PRD M9) and
// «المخطط المقيد» (UX.md) are verbatim from the documents; the rest is proposed copy under the owner decision D93 (best practice), with English proposed
// as everywhere (UI-tokens A7). No dash is written in new text (D80) and no source text of any book appears.
import type { SimulationAdjustment } from "@/lib/api/demo-endpoints";
import type { Locale } from "./messages";

export interface DemoMessages {
  entry: {
    screenName: string; // S-28: the H1 and the document title
    backDestination: string; // the screen the arrow names: the public catalog (S-07)
    intro: string;
    syntheticNote: string;
    submit: string;
    submitting: string;
    submittingStatus: string; // the polite announcement while E26 is in flight
    loginLink: string; // the tertiary link of S-01
  };
  scenario: {
    screenName: string; // S-29
    intro: string;
    privacyNote: string;
    legend: string;
    sectionCount: (formatted: string) => string;
    build: string;
    building: string;
    buildingStatus: string;
    chooseFirst: string;
    readyHelper: string;
    loading: string;
    empty: { text: string; action: string };
    built: { title: string; byRules: string; byPlanner: string; plan: (title: string) => string; continue: string };
    simulationsLink: string;
    failure: { activePlanRace: string; unknownScenario: string; uncertain: string; uncertainAction: string; dailyLimit: string };
  };
  simulations: {
    screenName: string; // S-30
    label: string; // «محسوبة سلفًا لا تشغيلًا حيًا»
    labelBody: string;
    loading: string;
    empty: string;
    profileHeading: string;
    profileName: string;
    profileWords: string;
    profileMinutes: string;
    scriptHeading: string;
    correctRate: string;
    absentDays: string;
    errorDays: string;
    none: string;
    scriptNote: string;
    percent: (formatted: string) => string;
    listSeparator: string;
    table: { caption: (title: string) => string; day: string; newWords: string; reviews: string; adjustment: string; confirmed: string; overall: string };
    dayLabel: (formatted: string) => string;
    adjustment: Record<SimulationAdjustment | "none", string>;
    lightReview: string;
    backToday: string;
    chooseOther: string;
  };
}

const ar: DemoMessages = {
  entry: {
    screenName: "رابط العرض التجريبي",
    backDestination: "تصفّح الكتب",
    intro: "أنشئ حساب عرض لتجرّب رحلة الحفظ كاملة ببيانات اصطناعية: اختيار هدف جاهز، ثم خطة، ثم جلسة وألعاب ومتابعة للتقدم.",
    syntheticNote: "حساب العرض لا يحمل بيانات حقيقية، ولا يقبل هدفًا حرًا. وتسري عليه شروط الاستخدام وبيان الخصوصية نفسها، ويُسمح بعدد محدود من حسابات العرض في اليوم من الاتصال نفسه.",
    submit: "إنشاء حساب العرض",
    submitting: "جارٍ إنشاء حساب العرض…",
    submittingStatus: "جارٍ إنشاء حساب العرض",
    loginLink: "رابط عرض تجريبي",
  },
  scenario: {
    screenName: "قائمة سيناريوهات أهداف اصطناعية",
    intro: "اختر هدفًا جاهزًا من القائمة، وسيبني منه المخطط المقيد خطتك مباشرة.",
    privacyNote: "لا يُرسل أي نص حر إلى النموذج. يُرسل فقط معرّف السيناريو، ومعرّفات المقاطع مع عدد كلماتها، وعدد الإجابات الصحيحة والخاطئة في اختبار أولي اصطناعي.",
    legend: "السيناريوهات",
    sectionCount: (formatted) => `عدد الأقسام: ${formatted}`,
    build: "ابنِ الخطة",
    building: "جارٍ بناء الخطة…",
    buildingStatus: "جارٍ بناء الخطة",
    chooseFirst: "اختر سيناريو لتفعيل الزر.",
    readyHelper: "تُحفظ الخطة في حساب العرض، وتحل محل الخطة الحالية إن وُجدت.",
    loading: "جارٍ تحميل السيناريوهات",
    empty: { text: "لا توجد سيناريوهات جاهزة الآن. يمكنك بدء خطة بنفسك.", action: "ابدأ خطتك" },
    built: {
      title: "تم بناء خطتك",
      byRules: "بُنيت هذه الخطة بمحرك القواعد داخل التطبيق.",
      byPlanner: "بُنيت هذه الخطة بواسطة «المخطط المقيد».",
      plan: (title) => `الخطة: ${title}`,
      continue: "المتابعة إلى خطتك",
    },
    simulationsLink: "محاكاة عدة أيام للقراءة فقط",
    failure: {
      activePlanRace: "بدأت خطة أخرى للتو. حدّث الصفحة ثم أعد المحاولة.",
      unknownScenario: "لم يعد هذا السيناريو متاحًا. حدّثنا القائمة، فاختر سيناريو آخر.",
      uncertain: "لم نتلقَّ تأكيدًا ببناء الخطة. افتح خطوتك اليوم لترى إن كانت قد بُنيت، وإلا فأعد المحاولة.",
      uncertainAction: "افتح خطوتك اليوم",
      dailyLimit: "لكل حساب عرض عدد محدود من بناء الخطط في اليوم.",
    },
  },
  simulations: {
    screenName: "محاكاة عدة أيام للقراءة فقط",
    label: "محسوبة سلفًا لا تشغيلًا حيًا",
    labelBody: "تعرض هذه الشاشة نتائج حُسبت سلفًا من سيناريوهات اصطناعية. وهي ليست نتيجة تشغيل حي ولا تقدّمَ متعلم حقيقي.",
    loading: "جارٍ تحميل المحاكاة",
    empty: "لا توجد محاكاة جاهزة الآن.",
    profileHeading: "الملف الاصطناعي",
    profileName: "اسم الملف",
    profileWords: "إجمالي الكلمات",
    profileMinutes: "الزمن اليومي بالدقائق",
    scriptHeading: "سلوك المتعلم المكتوب سلفًا",
    correctRate: "نسبة الإجابات الصحيحة اليومية",
    absentDays: "أيام الغياب",
    errorDays: "أيام الأخطاء",
    none: "لا يوجد",
    scriptNote: "هذه القيم سيناريو مكتوب سلفًا، وليست قياسًا لمتعلم حقيقي.",
    percent: (formatted) => `${formatted}٪`,
    listSeparator: "، ",
    table: {
      caption: (title) => `أيام المحاكاة: ${title}`,
      day: "اليوم",
      newWords: "كلمات جديدة",
      reviews: "مراجعات",
      adjustment: "التعديل",
      confirmed: "كلمات مؤكدة (تراكمي)",
      overall: "الإنجاز الكلي",
    },
    dayLabel: (formatted) => `اليوم ${formatted}`,
    adjustment: {
      none: "بلا تعديل",
      absence_light_review: "مراجعة خفيفة بعد الغياب",
      error_priority: "أولوية لمواضع الخطأ",
      pace_reduced: "تخفيف الوتيرة",
    },
    lightReview: "يوم مراجعة خفيفة بلا مادة جديدة",
    backToday: "العودة إلى خطوتك اليوم",
    chooseOther: "اختيار سيناريو آخر",
  },
};

const en: DemoMessages = {
  entry: {
    screenName: "Try the demo",
    backDestination: "Browse books",
    intro: "Create a demo account to try the whole memorization journey with synthetic data: choose a ready-made goal, then a plan, then a session, games and progress.",
    syntheticNote:
      "A demo account holds no real data and takes no free-text goal. The same terms of use and privacy statement apply, and the number of demo accounts is limited per day from the same connection.",
    submit: "Create demo account",
    submitting: "Creating the demo account…",
    submittingStatus: "Creating the demo account",
    loginLink: "Try the demo",
  },
  scenario: {
    screenName: "Synthetic goal scenarios",
    intro: "Choose a ready-made goal from the list, and the constrained planner builds your plan from it.",
    privacyNote: "No free text is sent to the model. Only the scenario id, the passage ids with their word counts, and the counts of right and wrong answers in a synthetic placement test are sent.",
    legend: "Scenarios",
    sectionCount: (formatted) => `Sections: ${formatted}`,
    build: "Build the plan",
    building: "Building the plan…",
    buildingStatus: "Building the plan",
    chooseFirst: "Choose a scenario to turn the button on.",
    readyHelper: "The plan is saved in the demo account and replaces the current plan, if there is one.",
    loading: "Loading the scenarios",
    empty: { text: "No ready-made scenarios are available right now. You can start a plan yourself.", action: "Start your plan" },
    built: {
      title: "Your plan is built",
      byRules: "This plan was built by the rules engine inside the app.",
      byPlanner: "This plan was built by the constrained planner.",
      plan: (title) => `Plan: ${title}`,
      continue: "Continue to your plan",
    },
    simulationsLink: "Multi-day read-only simulation",
    failure: {
      activePlanRace: "Another plan has just started. Refresh the page and try again.",
      unknownScenario: "This scenario is no longer available. We refreshed the list, so choose another.",
      uncertain: "We did not get a confirmation that the plan was built. Open your step today to see whether it was; otherwise try again.",
      uncertainAction: "Open your step today",
      dailyLimit: "Each demo account can build a limited number of plans per day.",
    },
  },
  simulations: {
    screenName: "Multi-day read-only simulation",
    label: "Precomputed, not a live run",
    labelBody: "This screen shows results computed in advance from synthetic scenarios. They are not a live run and not a real learner's progress.",
    loading: "Loading the simulations",
    empty: "No ready simulations are available right now.",
    profileHeading: "Synthetic profile",
    profileName: "Profile name",
    profileWords: "Total words",
    profileMinutes: "Daily time in minutes",
    scriptHeading: "Scripted learner behaviour",
    correctRate: "Daily share of correct answers",
    absentDays: "Days absent",
    errorDays: "Days with mistakes",
    none: "None",
    scriptNote: "These values are a scenario written in advance, not a measurement of a real learner.",
    percent: (formatted) => `${formatted}%`,
    listSeparator: ", ",
    table: {
      caption: (title) => `Simulated days: ${title}`,
      day: "Day",
      newWords: "New words",
      reviews: "Reviews",
      adjustment: "Adjustment",
      confirmed: "Confirmed words (running total)",
      overall: "Overall progress",
    },
    dayLabel: (formatted) => `Day ${formatted}`,
    adjustment: {
      none: "No adjustment",
      absence_light_review: "Light review after absence",
      error_priority: "Priority to the mistakes",
      pace_reduced: "Slower pace",
    },
    lightReview: "Light review day with no new material",
    backToday: "Back to your step today",
    chooseOther: "Choose another scenario",
  },
};

const CATALOGS: Record<Locale, DemoMessages> = { ar, en };

export function demoMessages(locale: Locale): DemoMessages {
  return CATALOGS[locale];
}
