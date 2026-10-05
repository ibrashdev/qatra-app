// The lessons tab (D92, owner approval of 5 October 2026): a read-only session that shows the verses or hadiths of the learner's own plan, with no
// questions and no games. Arabic and English are proposed copy (UI-tokens A7), except that the tab name «الدروس» and the rule that it only reads are the
// owner's words. Kept out of messages.ts, which another package owns: the screens read their catalog with lessonsMessages(locale).
// Where a line would hold a dash it is built from two elements instead (antislop R-02, no dash in new text).
import { formatInteger } from "./format";
import type { Locale } from "./messages";

export interface LessonsMessages {
  screenName: string; // the H1 and the document title of the list, and the name the reader's back control goes to
  lead: string; // what the tab is: text only, and that the time counts
  listLabel: string; // the accessible name of the list of sections
  passages: (count: number) => string; // «N مقاطع», shown on a surah card
  empty: { title: string; text: string; action: string }; // no active plan
  noSections: { title: string; text: string }; // an active plan with nothing to read
  reader: {
    textLabel: string; // the accessible name of the block that holds the text
    outOfPlan: { title: string; text: string; action: string }; // a section the active plan does not hold
  };
  retry: string;
}

const ARABIC_PLURALS = new Intl.PluralRules("ar");

function arabicPassages(count: number): string {
  const formatted = formatInteger("ar", count);
  if (count === 1) return "مقطع واحد";
  if (count === 2) return "مقطعان";
  return ARABIC_PLURALS.select(count) === "few" ? `${formatted} مقاطع` : `${formatted} مقطعًا`;
}

const ar: LessonsMessages = {
  screenName: "الدروس",
  lead: "اقرأ آيات خطتك وأحاديثها دون أسئلة ولا ألعاب. تُحتسب مدة القراءة في تقدمك اليومي.",
  listLabel: "مقاطع خطتك",
  passages: arabicPassages,
  empty: {
    title: "لا توجد خطة نشطة بعد.",
    text: "الدروس تعرض مقاطع خطتك النشطة، فابدأ خطة لتقرأها.",
    action: "ابدأ خطتك",
  },
  noSections: {
    title: "لا توجد مقاطع لتقرأها.",
    text: "لا يوجد في نطاق خطتك النشطة ما يُعرض هنا.",
  },
  reader: {
    textLabel: "نص الدرس",
    outOfPlan: {
      title: "هذا الدرس ليس ضمن خطتك.",
      text: "الدروس تعرض مقاطع خطتك النشطة فقط.",
      action: "العودة إلى الدروس",
    },
  },
  retry: "إعادة المحاولة",
};

const en: LessonsMessages = {
  screenName: "Lessons",
  lead: "Read the verses or hadiths of your plan, with no questions and no games. Reading time counts toward your daily progress.",
  listLabel: "Your plan's passages",
  passages: (count) => `${formatInteger("en", count)} ${count === 1 ? "passage" : "passages"}`,
  empty: {
    title: "There is no active plan yet.",
    text: "Lessons show the passages of your active plan, so start a plan to read them.",
    action: "Start your plan",
  },
  noSections: {
    title: "There is nothing to read yet.",
    text: "Your active plan holds nothing to show here.",
  },
  reader: {
    textLabel: "Lesson text",
    outOfPlan: {
      title: "This lesson is not in your plan.",
      text: "Lessons show only the passages of your active plan.",
      action: "Back to Lessons",
    },
  },
  retry: "Try again",
};

const CATALOGS: Record<Locale, LessonsMessages> = { ar, en };

export function lessonsMessages(locale: Locale): LessonsMessages {
  return CATALOGS[locale];
}
