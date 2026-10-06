// Strings of the shared question pieces (UI-screens part C: S-09 and S-15 to S-19, P-18 to P-22, UI-tokens 6.16 and 6.17).
// Arabic is verbatim from docs/UI-screens.md; English is proposed (UI-tokens A7). Kept out of messages.ts, which another package owns:
// the pieces read their catalog with questionMessages(locale).
import { formatInteger } from "./format";
import type { Locale } from "./messages";

export interface QuestionMessages {
  prompts: {
    wordOrder: string;
    wordChoiceWord: string;
    wordChoiceSegment: string;
    wordChoiceGrade: string;
    similar: string;
    recall: string;
    placementChoice: string; // S-09 c8, a word_choice question
    placementRecall: string; // S-09 c9, a word_recall question
  };
  blank: { word: string; part: string }; // the accessible name of a blank slot (P-20)
  groups: { options: string; answerLine: string; pool: string };
  helpers: { wordOrder: string; recall: string };
  recallLabel: string;
  errors: { incomplete: string; empty: string; multipleWords: string; recallEmpty: string };
  hint: {
    label: string;
    assisted: string; // the info chip
    similarHelper: string; // before the press (UG-09)
    reviewHelper: string; // a review round (O-35)
    firstLetterLabel: string; // the visible line shows the label and the letter apart, so the letter keeps the book font
    firstLetter: (letter: string) => string; // the polite announcement
    optionRemoved: string;
    firstPlaced: string;
  };
  order: {
    undo: string;
    placed: (word: string, position: string) => string; // polite announcement
    removed: (word: string) => string;
    poolChip: (word: string) => string;
    usedChip: (word: string) => string;
    placedChip: (word: string, position: string, total: string) => string;
    lockedChip: (word: string, position: string) => string;
    checkedChip: (word: string, position: string, total: string, inPlace: boolean) => string;
    inPlace: string;
    notInPlace: string;
  };
  tile: {
    selected: (text: string) => string; // polite announcement
    correct: string;
    chosenNeedsReview: string;
    mistake: string; // D31, the wrong option of a similar distinction
    correctName: (text: string) => string;
    chosenNeedsReviewName: (text: string) => string;
    mistakeName: (text: string) => string;
  };
  feedback: {
    correct: string;
    needsReview: string;
    assistedNote: string;
    rejected: string;
    pending: string;
    updated: string;
  };
  source: { page: (pages: string) => string; link: string; opensInNewTab: (reference: string) => string };
  d50Notice: string;
}

const ar: QuestionMessages = {
  prompts: {
    wordOrder: "رتّب الكلمات كما وردت في النص.",
    wordChoiceWord: "اختر الكلمة الناقصة.",
    wordChoiceSegment: "اختر ما يأتي بعد ذلك.",
    wordChoiceGrade: "اختر العبارة التي ذكرها المصدر عن درجة هذا الحديث",
    similar: "اختر الصحيح كما ورد في الكتاب.",
    recall: "اكتب الكلمة الناقصة.",
    placementChoice: "اختر الكلمة التي تكمل العبارة.",
    placementRecall: "اكتب الكلمة الناقصة.",
  },
  blank: { word: "الكلمة الناقصة", part: "الجزء الناقص" },
  groups: { options: "الخيارات", answerLine: "ترتيبك", pool: "الكلمات المتاحة" },
  helpers: { wordOrder: "اضغط كلمة لوضعها، واضغطها في سطر الإجابة لإزالتها.", recall: "اكتب الكلمة بالعربية. لا يلزم كتابة الحركات." },
  recallLabel: "الكلمة الناقصة",
  errors: { incomplete: "رتّب جميع الكلمات أولًا.", empty: "اختر إجابة أولًا.", multipleWords: "اكتب كلمة واحدة.", recallEmpty: "اكتب كلمة أولًا." },
  hint: {
    label: "تلميح",
    assisted: "بمساعدة",
    similarHelper: "يُزيل الخيار الخاطئ فيبقى الخيار الصحيح، وتُحتسب الإجابة بمساعدة.",
    reviewHelper: "التلميح في المراجعة لا يُنجح الجولة.",
    firstLetterLabel: "أول حرف:",
    firstLetter: (letter) => `أول حرف: ${letter}`,
    optionRemoved: "حُذف خيار خاطئ",
    firstPlaced: "وُضعت الكلمة الأولى في موضعها.",
  },
  order: {
    undo: "تراجع",
    placed: (word, position) => `وُضعت «${word}» في الموضع ${position}.`,
    removed: (word) => `أُزيلت «${word}».`,
    poolChip: (word) => word,
    usedChip: (word) => `${word}، مستخدمة`,
    placedChip: (word, position, total) => `${word}، الموضع ${position} من ${total}، اضغط لإزالتها`,
    lockedChip: (word, position) => `${word}، الموضع ${position}، وُضعت بتلميح`,
    checkedChip: (word, position, total, inPlace) => `${word}، الموضع ${position} من ${total}، ${inPlace ? "في موضعها" : "ليست في موضعها"}`,
    inPlace: "في موضعها",
    notInPlace: "ليست في موضعها",
  },
  tile: {
    selected: (text) => `تم اختيار «${text}».`,
    correct: "الصحيح",
    chosenNeedsReview: "اخترته، يحتاج مراجعة",
    mistake: "خطأ في الحفظ",
    correctName: (text) => `${text}، الصحيح`,
    chosenNeedsReviewName: (text) => `${text}، اخترته، يحتاج مراجعة`,
    mistakeName: (text) => `${text}، خطأ في الحفظ`,
  },
  feedback: {
    correct: "إجابة صحيحة.",
    needsReview: "هذا الموضع يحتاج إلى مراجعة. الأصل:",
    assistedNote: "الإجابة بمساعدة تُحتسب تدريبًا ولا تُعدّ دليلًا مستقلًا على الاسترجاع.",
    rejected: "لم تُحتسب هذه الإجابة.",
    pending: "ما زالت هذه الإجابة قيد التحقق.",
    updated: "تم تحديث نتيجة هذا السؤال.",
  },
  source: { page: (pages) => `ص ${pages}`, link: "المصدر", opensInNewTab: (reference) => `المصدر: ${reference}، يفتح في نافذة جديدة` },
  d50Notice: "تنبيه: نُقل هذا النص حرفيًا عن الكتاب، ولم يُتحقق من صحة الحديث.",
};

const en: QuestionMessages = {
  prompts: {
    wordOrder: "Put the words in the order they appear in the text.",
    wordChoiceWord: "Choose the missing word.",
    wordChoiceSegment: "Choose what comes next.",
    wordChoiceGrade: "Choose the phrase the source gives for this hadith's grade",
    similar: "Choose the correct one as it appears in the book.",
    recall: "Type the missing word.",
    placementChoice: "Choose the word that completes the phrase.",
    placementRecall: "Type the missing word.",
  },
  blank: { word: "the missing word", part: "the missing part" },
  groups: { options: "Options", answerLine: "Your order", pool: "Available words" },
  helpers: { wordOrder: "Tap a word to place it; tap it in the answer line to remove it.", recall: "Type the word in Arabic. Vowel marks are not needed." },
  recallLabel: "The missing word",
  errors: { incomplete: "Place all the words first.", empty: "Choose an answer first.", multipleWords: "Type one word only.", recallEmpty: "Type a word first." },
  hint: {
    label: "Hint",
    assisted: "With help",
    similarHelper: "It removes the wrong option, leaving the correct one, and the answer counts as with help.",
    reviewHelper: "A hint in a review does not pass the round.",
    firstLetterLabel: "First letter:",
    firstLetter: (letter) => `First letter: ${letter}`,
    optionRemoved: "A wrong option was removed",
    firstPlaced: "The first word was placed in its position.",
  },
  order: {
    undo: "Undo",
    placed: (word, position) => `“${word}” placed in position ${position}.`,
    removed: (word) => `“${word}” removed.`,
    poolChip: (word) => word,
    usedChip: (word) => `${word}, used`,
    placedChip: (word, position, total) => `${word}, position ${position} of ${total}, press to remove`,
    lockedChip: (word, position) => `${word}, position ${position}, placed by hint`,
    checkedChip: (word, position, total, inPlace) => `${word}, position ${position} of ${total}, ${inPlace ? "in place" : "not in place"}`,
    inPlace: "in place",
    notInPlace: "not in place",
  },
  tile: {
    selected: (text) => `“${text}” selected.`,
    correct: "The correct one",
    chosenNeedsReview: "Your choice: needs review",
    mistake: "A memorization error",
    correctName: (text) => `${text}, the correct one`,
    chosenNeedsReviewName: (text) => `${text}, your choice, needs review`,
    mistakeName: (text) => `${text}, a memorization error`,
  },
  feedback: {
    correct: "Correct.",
    needsReview: "This spot needs review. The original:",
    assistedNote: "An answer with help counts as practice, not as independent recall.",
    rejected: "This answer was not counted.",
    pending: "This answer is still being verified.",
    updated: "The result of this question was updated.",
  },
  source: { page: (pages) => `p. ${pages}`, link: "Source", opensInNewTab: (reference) => `Source: ${reference}, opens in a new tab` },
  d50Notice: "Note: this text was transcribed verbatim from the book, and the hadith's authenticity has not been verified.",
};

const CATALOGS: Record<Locale, QuestionMessages> = { ar, en };

export function questionMessages(locale: Locale): QuestionMessages {
  return CATALOGS[locale];
}

// Positions in the live regions and chip names follow the digit rule of the interface language (UI-tokens 3.4).
export function formatPosition(locale: Locale, value: number): string {
  return formatInteger(locale, value);
}
