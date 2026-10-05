// Policy `arabic-norm-v1` (Implementation-contract 2.5), for the local first verdict of a recall answer and for the mock server. The real server grades;
// its `results[]` entry replaces anything computed here.

// Zero-width characters, tatweel, harakat, tanwin, shadda, sukun, superscript alef and the Quranic marks.
const REMOVED = /[​-‏﻿ـً-ٰٟۖ-ۭ]/gu;
const ARABIC_INDIC_DIGITS = /[٠-٩]/gu;
const PUNCTUATION = /[\p{P}«»]/gu;

const LETTER_MAP: Readonly<Record<string, string>> = {
  "أ": "ا", // alef with hamza above
  "إ": "ا", // alef with hamza below
  "آ": "ا", // alef with madda
  "ٱ": "ا", // alef wasla
  "ٲ": "ا",
  "ٳ": "ا",
  "ى": "ي", // alef maqsura to ya
  "ة": "ه", // ta marbuta to ha
  "ؤ": "و", // waw with hamza
  "ئ": "ي", // ya with hamza
};

export function normalizeArabicWord(text: string): string {
  return text
    .normalize("NFC")
    .replace(REMOVED, "")
    .replace(ARABIC_INDIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(PUNCTUATION, "")
    .replace(/[أإآٱٲٳىةؤئ]/gu, (letter) => LETTER_MAP[letter] ?? letter)
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}
