// S-14 to S-18 (the games hub and the four rounds) strings and the learning-cycle cue (FC-13). Arabic is verbatim from docs/UI-screens.md S-14 to S-18
// (P-18 to P-25) and docs/Figma-code-handoff.md FC-13; English is proposed (UI-tokens A7).
// Kept out of messages.ts, which another package owns: the screens read their catalog with gamesMessages(locale).
// Where the Arabic copy of the document holds a dash, the line is built from two elements instead (antislop R-02, no dash in new text).
import type { GameKind } from "@/lib/api/types";
import { formatInteger } from "./format";
import type { Locale } from "./messages";

export interface GameCopy {
  name: string; // the H1 of the round and the name of the hub row
  description: string; // the description of the hub row
}

export interface GamesMessages {
  screenName: string; // S-14 c1, the H1 and the document title
  planLine: string; // c2, has {title}
  notice: string; // c3
  games: Record<GameKind, GameCopy>; // c4 to c7
  empty: { title: string; text: string; action: string }; // c8
  starting: string;
  unavailable: { text: string; action: string }; // G-20 on the hub and the round
  round: {
    leave: string; // the name of the back control of a round
    counter: (k: number, n: number, locale: Locale) => string;
    primary: { check: string; next: string; finish: string };
    sheet: { title: string; body: string; keepGoing: string; leave: string; saving: string; failed: string; retry: string; leaveUnsaved: string };
    banners: { planInactive: string; sessionClosed: string; backToGames: string };
    empty: { material: string; similar: string; action: string }; // P-24
    result: {
      title: string;
      backToGames: string; // the destination after "Back to"
      withHelp: (k: string) => string;
      needsReview: string;
      playAgain: string;
      games: string;
      loading: string;
    };
  };
}

const ar: GamesMessages = {
  screenName: "الألعاب",
  planLine: "من خطتك النشطة: {title}",
  notice: "تُختار الأسئلة من مادة خطتك ونسختها، بما فيها أيام قادمة، دون إكمال درس. في كل جولة حتى ١٠ أسئلة، ويُحتسب وقت اللعب من هدفك اليومي.",
  games: {
    word_order: { name: "ترتيب الكلمات", description: "رتّب كلمات جزء من النص كما وردت." },
    word_choice: { name: "اختيار كلمة أو جزء", description: "اختر الكلمة أو الجزء المتصل الذي يكمل النص." },
    similar_distinction: { name: "تمييز المتشابه", description: "اختر الصحيح من خيارين متشابهين كما ورد في الكتاب." },
    word_recall: { name: "استرجاع كلمة", description: "اكتب الكلمة الناقصة من الذاكرة." },
  },
  empty: { title: "لا توجد خطة نشطة بعد.", text: "تحتاج الألعاب إلى خطة نشطة لاختيار المادة منها.", action: "ابدأ خطتك" },
  starting: "جارٍ بدء الجولة",
  unavailable: { text: "هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.", action: "ابدأ خطتك" },
  round: {
    leave: "مغادرة الجولة",
    counter: (k, n, locale) => `السؤال ${formatInteger(locale, k)} من ${formatInteger(locale, n)}`,
    primary: { check: "تحقق", next: "التالي", finish: "إنهاء الجولة" },
    sheet: {
      title: "مغادرة الجولة؟",
      body: "سنحفظ إجاباتك حتى الآن، ولا يمكن استئناف الجولة. يمكنك بدء جولة جديدة في أي وقت.",
      keepGoing: "متابعة اللعب",
      leave: "إنهاء الجولة والخروج",
      saving: "جارٍ الحفظ…",
      failed: "تعذّر حفظ إجاباتك الأخيرة.",
      retry: "إعادة المحاولة",
      leaveUnsaved: "المغادرة دون حفظ",
    },
    banners: { planInactive: "هذه الخطة غير نشطة.", sessionClosed: "انتهت هذه الجولة.", backToGames: "العودة إلى الألعاب" },
    empty: {
      material: "لا توجد مادة للعب ضمن خطتك الآن.",
      similar: "لا يوجد موضع متشابه ولا خطأ مسجل لك في هذا المقطع؛ جرّب لعبة أخرى.",
      action: "اختر لعبة أخرى",
    },
    result: {
      title: "نتيجة الجولة",
      backToGames: "الألعاب",
      withHelp: (k) => `منها بمساعدة: ${k}`,
      needsReview: "تُضاف الأجزاء التي تحتاج إلى مراجعة إلى مراجعاتك القادمة.",
      playAgain: "العب مرة أخرى",
      games: "الألعاب",
      loading: "جارٍ التحميل",
    },
  },
};

const en: GamesMessages = {
  screenName: "Games",
  planLine: "From your active plan: {title}",
  notice: "Questions come from your plan's material and edition, including coming days, with no lesson to finish first. A round has up to 10 questions, and playing time counts toward your daily goal.",
  games: {
    word_order: { name: "Word order", description: "Put the words of a part of the text in their original order." },
    word_choice: { name: "Word or segment choice", description: "Choose the word or connected part that completes the text." },
    similar_distinction: { name: "Similar distinction", description: "Choose the correct one of two similar options as it appears in the book." },
    word_recall: { name: "Word recall", description: "Type the missing word from memory." },
  },
  empty: { title: "There is no active plan yet.", text: "Games need an active plan to choose material from.", action: "Start your plan" },
  starting: "Starting the round",
  unavailable: { text: "This edition is no longer available. You can start a plan on another edition.", action: "Start your plan" },
  round: {
    leave: "Leave the round",
    counter: (k, n, locale) => `Question ${formatInteger(locale, k)} of ${formatInteger(locale, n)}`,
    primary: { check: "Check", next: "Next", finish: "Finish the round" },
    sheet: {
      title: "Leave the round?",
      body: "We will save your answers so far, and a round cannot be resumed. You can start a new round at any time.",
      keepGoing: "Keep playing",
      leave: "End the round and leave",
      saving: "Saving…",
      failed: "We could not save your latest answers.",
      retry: "Try again",
      leaveUnsaved: "Leave without saving",
    },
    banners: { planInactive: "This plan is not active.", sessionClosed: "This round has ended.", backToGames: "Back to Games" },
    empty: {
      material: "There is nothing to play in your plan right now.",
      similar: "There is no similar position and no error recorded for you in this passage; try another game.",
      action: "Choose another game",
    },
    result: {
      title: "Round result",
      backToGames: "Games",
      withHelp: (k) => `With help: ${k}`,
      needsReview: "Parts that need review are added to your coming reviews.",
      playAgain: "Play again",
      games: "Games",
      loading: "Loading",
    },
  },
};

const CATALOGS: Record<Locale, GamesMessages> = { ar, en };

export function gamesMessages(locale: Locale): GamesMessages {
  return CATALOGS[locale];
}

// FC-13 (docs/Figma-code-handoff.md): the heading and the caption are verbatim from the handoff. The three stage labels in both languages were approved by the
// owner on 5 October 2026.
export interface LearningCueMessages {
  heading: string;
  stages: readonly [string, string, string]; // training and coverage, successful reviews on days 1, 3 and 7, confirmed mastery
  caption: string;
}

const cueAr: LearningCueMessages = {
  heading: "مسار الإتقان · خطوات عامة",
  stages: ["تدريب وتغطية", "نجاح مراجعات الأيام ١ ٣ ٧", "تأكيد التمكّن"],
  caption: "التدريب والمراجعة يساعدانك على تثبيت حفظك.",
};

const cueEn: LearningCueMessages = {
  heading: "Mastery path · general steps",
  stages: ["Practice and coverage", "Reviews pass on days 1, 3, 7", "Mastery confirmed"],
  caption: "Training and review help you make your memorization stick.",
};

const CUE_CATALOGS: Record<Locale, LearningCueMessages> = { ar: cueAr, en: cueEn };

export function learningCueMessages(locale: Locale): LearningCueMessages {
  return CUE_CATALOGS[locale];
}
