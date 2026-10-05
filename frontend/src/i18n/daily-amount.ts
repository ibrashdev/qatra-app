// The daily amount of new material in whole units (D92): "about 3 ayat a day", "a new hadith every 2 days".
// The server counts the pace in words; the learner is told whole ayat or hadith, never a split unit. A plan stored before D92 and an edition without
// a unit count carry no `dailyNew`: the words figure is shown then, as before.
import type { DailyNew, Estimate } from "@/lib/api/types";
import { formatInteger } from "./format";
import type { Locale } from "./messages";

const ARABIC_PLURALS = new Intl.PluralRules("ar");
// The few form (3 to 10) takes the plural noun, every other count the singular.
const arabicNoun = (count: number, singular: string, plural: string): string => (ARABIC_PLURALS.select(count) === "few" ? plural : singular);

// «كل يوم», «كل يومين», «كل ٣ أيام», «كل ١١ يومًا».
function arabicEveryDays(days: number, formatted: string): string {
  if (days === 1) return "كل يوم";
  if (days === 2) return "كل يومين";
  return `كل ${formatted} ${arabicNoun(days, "يومًا", "أيام")}`;
}

// «N new ayat or hadith» with the Arabic agreement: one and two take the singular and the dual with their adjective, 3 to 10 the plural,
// 11 and above the singular in the accusative.
function arabicNewUnits(unit: DailyNew["unit"], count: number, formatted: string): string {
  const ayah = unit === "ayah";
  if (count === 1) return ayah ? "آية جديدة" : "حديث جديد";
  if (count === 2) return ayah ? "آيتان جديدتان" : "حديثان جديدان";
  if (ARABIC_PLURALS.select(count) === "few") return `${formatted} ${ayah ? "آيات" : "أحاديث"} جديدة`;
  return `${formatted} ${ayah ? "آية جديدة" : "حديثًا جديدًا"}`;
}

function arabicAmount(daily: DailyNew, locale: Locale): string {
  const noun = daily.unit === "ayah" ? "آية جديدة" : "حديث جديد";
  if (daily.everyDays !== null) return `و${noun} ${arabicEveryDays(daily.everyDays, formatInteger(locale, daily.everyDays))}`;
  const perDay = daily.perDay ?? 1;
  const formatted = formatInteger(locale, perDay);
  if (perDay === 1 && daily.unit === "hadith") return `و${noun} ${arabicEveryDays(1, formatted)}`;
  if (perDay <= 2) return `و${arabicNewUnits(daily.unit, perDay, formatted)} في اليوم`;
  return `ونحو ${arabicNewUnits(daily.unit, perDay, formatted)} في اليوم`;
}

function englishAmount(daily: DailyNew, locale: Locale): string {
  const ayah = daily.unit === "ayah";
  if (daily.everyDays !== null) return `a new ${ayah ? "ayah" : "hadith"} ${daily.everyDays === 1 ? "every day" : `every ${formatInteger(locale, daily.everyDays)} days`}`;
  const perDay = daily.perDay ?? 1;
  if (perDay === 1) return `a new ${ayah ? "ayah" : "hadith"} a day`;
  return `${perDay >= 3 ? "about " : ""}${formatInteger(locale, perDay)} new ${ayah ? "ayat" : "hadiths"} a day`;
}

const wordsAmount = (locale: Locale, words: number): string => {
  const formatted = formatInteger(locale, words);
  if (locale === "ar") return `وحتى ${formatted} ${arabicNoun(words, "كلمة", "كلمات")} جديدة في اليوم`;
  return `up to ${formatted} new ${words === 1 ? "word" : "words"} a day`;
};

// The clause that follows «يوميًا،» or "a day,": the whole-unit amount, or the words figure when the estimate has no `dailyNew`.
// Arabic starts with the conjunction «و», as in «١٥ دقيقة يوميًا، ونحو ٣ آيات جديدة في اليوم».
export function dailyAmountText(locale: Locale, estimate: Pick<Estimate, "dailyNew" | "newWordsPerDay">): string {
  const daily = estimate.dailyNew;
  if (daily === undefined || daily === null || (daily.perDay === null) === (daily.everyDays === null)) return wordsAmount(locale, estimate.newWordsPerDay);
  return locale === "ar" ? arabicAmount(daily, locale) : englishAmount(daily, locale);
}
