// S-20 (session result) strings. Arabic is verbatim from docs/UI-screens.md S-20; English is proposed (UI-tokens A7).
// The daily indicator and its completion line come from todayMessages(locale).daily, so both screens say it the same way.
import type { Locale } from "./messages";

export interface ResultMessages {
  screenName: string; // c1, the H1 and the document title
  answers: { label: string; value: (correct: string, answered: string) => string; none: string }; // c2
  newPassages: string; // c3
  reviewsPassed: string; // c4
  reviewsReturning: string; // c5
  activeTime: { label: string; value: string }; // c6; value has {time}
  actions: { today: string; extra: string; progress: string }; // c8
}

const ar: ResultMessages = {
  screenName: "انتهت الجلسة",
  answers: { label: "الإجابات", value: (correct, answered) => `${correct} من ${answered} صحيحة`, none: "لم تُسجَّل إجابات في هذه الجلسة." },
  newPassages: "مقاطع جديدة",
  reviewsPassed: "مراجعات ناجحة",
  reviewsReturning: "مراجعات تعود في يوم التعلم التالي",
  activeTime: { label: "الوقت النشط", value: "{time} دقائق" },
  actions: { today: "العودة إلى اليوم", extra: "تدريب إضافي", progress: "عرض تقدمك" },
};

const en: ResultMessages = {
  screenName: "The session is over",
  answers: { label: "Answers", value: (correct, answered) => `${correct} of ${answered} correct`, none: "No answers were recorded in this session." },
  newPassages: "New passages",
  reviewsPassed: "Reviews passed",
  reviewsReturning: "Reviews coming back on the next learning day",
  activeTime: { label: "Active time", value: "{time} minutes" },
  actions: { today: "Back to Today", extra: "Extra practice", progress: "View your progress" },
};

const CATALOGS: Record<Locale, ResultMessages> = { ar, en };

export function resultMessages(locale: Locale): ResultMessages {
  return CATALOGS[locale];
}
