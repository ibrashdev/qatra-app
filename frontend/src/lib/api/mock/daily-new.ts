// The mock server's daily amount in whole units (D92), by the same rule as the real one: the scope's units, in proportion to the words still to learn,
// spread over the estimated days, rounded half up. Synthetic: the placeholder surahs have no ayah list, so an ayah is taken as 5 words, and a
// hadith section is one hadith.
import type { CatalogSection, DailyNew } from "../types";

const MOCK_WORDS_PER_AYAH = 5;

const roundHalfUp = (numerator: number, denominator: number): number => Math.floor((2 * numerator + denominator) / (2 * denominator));

export function mockDailyNew(sections: readonly CatalogSection[], days: number, totalWords: number, knownWords = 0): DailyNew | null {
  const remainingWords = totalWords - knownWords;
  const first = sections[0];
  if (first === undefined || days <= 0 || totalWords <= 0 || remainingWords <= 0) return null;
  const unit = first.kind === "surah" ? "ayah" : "hadith";
  const units = sections.reduce((sum, section) => sum + (unit === "ayah" ? Math.max(1, Math.ceil(section.wordCount / MOCK_WORDS_PER_AYAH)) : 1), 0);
  const remaining = Math.max(1, roundHalfUp(units * remainingWords, totalWords));
  return remaining >= days ? { unit, perDay: Math.max(1, roundHalfUp(remaining, days)), everyDays: null } : { unit, perDay: null, everyDays: Math.max(1, roundHalfUp(days, remaining)) };
}
