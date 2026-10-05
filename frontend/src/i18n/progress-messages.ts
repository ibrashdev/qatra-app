// S-21 (results and progress) strings. Arabic is verbatim from docs/UI-screens.md S-21 and UI-tokens 6.10 and 6.11; English is proposed (UI-tokens A7).
// Daily labels, the empty state, the revoked banner, the completed-plan banner and the retry label come from today-messages.ts.
import type { Locale } from "./messages";

export type SectionStatus = "new" | "learning" | "reviewing" | "confirmed" | "needs_refresh";
export type SectionKind = "surah" | "hadith" | "section";

export interface ProgressMessages {
  screenName: string; // c1, the H1 and the document title
  basis: string; // c3
  streak: { days: (formatted: string) => string; none: string }; // c4
  overall: {
    label: string; // c5
    percent: (formatted: string) => string;
    valueText: (formatted: string) => string; // aria-valuetext
    words: (confirmed: string, total: string) => string; // c6
    sections: (confirmed: string, total: string, kind: SectionKind) => string; // c6
    notice: string; // c6
    zero: string; // c11
  };
  nextReview: { date: (formatted: string) => string; none: string }; // c7
  groups: { confirmed: string; progress: string; needsRefresh: string; name: (label: string, count: string) => string }; // c8
  badges: Record<SectionStatus, string>; // c9
  sectionPercent: (formatted: string) => string; // c9
  refreshNote: string; // c10
}

const ar: ProgressMessages = {
  screenName: "النتائج والتقدم",
  basis: "الوقت النشط مقابل هدفك اليومي. تُحسب القراءة واللعب، وإن كانت بعض الإجابات خاطئة.",
  streak: { days: (formatted) => `أيام متتالية بلغتَ فيها هدفك: ${formatted}`, none: "لا توجد أيام متتالية بعد." },
  overall: {
    label: "الإنجاز الكلي للخطة",
    percent: (formatted) => `${formatted}٪`,
    valueText: (formatted) => `${formatted} بالمئة من الكلمات مؤكدة`,
    words: (confirmed, total) => `${confirmed} من ${total} كلمة مؤكدة`,
    sections: (confirmed, total, kind) => `${confirmed} من ${total} ${kind === "surah" ? "سورة" : kind === "hadith" ? "حديث" : "قسم"} مؤكدة`,
    notice: "هذه النسبة مؤشر تقدم في خطتك، وليست شهادة حفظ.",
    zero: "يظهر التقدم هنا بعد أن تؤكد أول مقطع؛ التأكيد يأتي بعد مراجعات متباعدة.",
  },
  nextReview: { date: (formatted) => `موعد المراجعة التالي: ${formatted}`, none: "لا توجد مراجعة قادمة بعد." },
  groups: { confirmed: "المؤكدة", progress: "قيد التقدم", needsRefresh: "يحتاج تحديثًا", name: (label, count) => `${label} (${count})` },
  badges: { new: "جديد", learning: "قيد التعلم", reviewing: "قيد التقدم", confirmed: "مؤكد", needs_refresh: "يحتاج تحديثًا" },
  sectionPercent: (formatted) => `${formatted}٪`,
  refreshNote: "هذه المقاطع احتاجت إلى مراجعة بعد تأكيدها، فخرجت مؤقتًا من الإنجاز الكلي حتى تجتاز مراجعاتها من جديد.",
};

const en: ProgressMessages = {
  screenName: "Results and progress",
  basis: "Active time against your daily goal. Reading and play both count, even with some wrong answers.",
  streak: { days: (formatted) => `Days in a row you reached your goal: ${formatted}`, none: "No days in a row yet." },
  overall: {
    label: "Overall plan progress",
    percent: (formatted) => `${formatted}%`,
    valueText: (formatted) => `${formatted} percent of the words confirmed`,
    words: (confirmed, total) => `${confirmed} of ${total} words confirmed`,
    sections: (confirmed, total, kind) => `${confirmed} of ${total} ${kind === "surah" ? "surahs" : kind === "hadith" ? "hadiths" : "sections"} confirmed`,
    notice: "This percentage is a progress indicator for your plan, not a memorization certificate.",
    zero: "Progress appears after you confirm your first passage; confirmation comes after spaced reviews.",
  },
  nextReview: { date: (formatted) => `Next review: ${formatted}`, none: "No review is coming up yet." },
  groups: { confirmed: "Confirmed", progress: "In progress", needsRefresh: "Needs refresh", name: (label, count) => `${label} (${count})` },
  badges: { new: "New", learning: "Learning", reviewing: "In progress", confirmed: "Confirmed", needs_refresh: "Needs refresh" },
  sectionPercent: (formatted) => `${formatted}%`,
  refreshNote: "These passages needed a review after they were confirmed, so they are temporarily outside overall progress until they pass their reviews again.",
};

const CATALOGS: Record<Locale, ProgressMessages> = { ar, en };

export function progressMessages(locale: Locale): ProgressMessages {
  return CATALOGS[locale];
}
