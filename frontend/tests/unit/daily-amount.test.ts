import { describe, expect, it } from "vitest";
import { dailyAmountText } from "@/i18n/daily-amount";
import { todayMessages } from "@/i18n/today-messages";
import { planReviseMessages } from "@/i18n/plan-revise-messages";
import { mockDailyNew } from "@/lib/api/mock/daily-new";
import type { CatalogSection, DailyNew } from "@/lib/api/types";

const ayat = (perDay: number): DailyNew => ({ unit: "ayah", perDay, everyDays: null });
const hadith = (perDay: number): DailyNew => ({ unit: "hadith", perDay, everyDays: null });
const hadithEvery = (everyDays: number): DailyNew => ({ unit: "hadith", perDay: null, everyDays });
const text = (locale: "ar" | "en", dailyNew: DailyNew | null | undefined) => dailyAmountText(locale, { newWordsPerDay: 25, dailyNew });

describe("the daily amount in whole units (D90), Arabic", () => {
  it.each([
    [ayat(1), "وآية جديدة في اليوم"],
    [ayat(2), "وآيتان جديدتان في اليوم"],
    [ayat(3), "ونحو ٣ آيات جديدة في اليوم"],
    [ayat(10), "ونحو ١٠ آيات جديدة في اليوم"],
    [ayat(11), "ونحو ١١ آية جديدة في اليوم"],
    [ayat(40), "ونحو ٤٠ آية جديدة في اليوم"],
    [hadith(1), "وحديث جديد كل يوم"],
    [hadith(2), "وحديثان جديدان في اليوم"],
    [hadith(5), "ونحو ٥ أحاديث جديدة في اليوم"],
    [hadith(12), "ونحو ١٢ حديثًا جديدًا في اليوم"],
    [hadithEvery(1), "وحديث جديد كل يوم"],
    [hadithEvery(2), "وحديث جديد كل يومين"],
    [hadithEvery(3), "وحديث جديد كل ٣ أيام"],
    [hadithEvery(10), "وحديث جديد كل ١٠ أيام"],
    [hadithEvery(11), "وحديث جديد كل ١١ يومًا"],
    [{ unit: "ayah", perDay: null, everyDays: 2 } as const, "وآية جديدة كل يومين"],
  ])("%j reads %s", (daily, expected) => {
    expect(text("ar", daily)).toBe(expected);
  });

  it("joins the daily time into the sentence of the plan", () => {
    const { daily } = todayMessages("ar");
    expect(daily.text("١٥", 15, text("ar", ayat(3)))).toBe("١٥ دقيقة يوميًا، ونحو ٣ آيات جديدة في اليوم");
    expect(daily.text("١٥", 15, text("ar", ayat(1)))).toBe("١٥ دقيقة يوميًا، وآية جديدة في اليوم");
    expect(daily.text("١٥", 15, text("ar", hadithEvery(2)))).toBe("١٥ دقيقة يوميًا، وحديث جديد كل يومين");
    expect(daily.text("٥", 5, text("ar", hadith(2)))).toBe("٥ دقائق يوميًا، وحديثان جديدان في اليوم");
    expect(planReviseMessages("ar").preview.daily("١٥", 15, text("ar", hadithEvery(3)))).toBe("١٥ دقيقة يوميًا، وحديث جديد كل ٣ أيام");
  });
});

describe("the daily amount in whole units (D90), English", () => {
  it.each([
    [ayat(1), "a new ayah a day"],
    [ayat(2), "2 new ayat a day"],
    [ayat(3), "about 3 new ayat a day"],
    [ayat(11), "about 11 new ayat a day"],
    [hadith(1), "a new hadith a day"],
    [hadith(4), "about 4 new hadiths a day"],
    [hadithEvery(1), "a new hadith every day"],
    [hadithEvery(2), "a new hadith every 2 days"],
    [hadithEvery(11), "a new hadith every 11 days"],
  ])("%j reads %s", (daily, expected) => {
    expect(text("en", daily)).toBe(expected);
  });

  it("joins the daily time into the sentence of the plan", () => {
    expect(todayMessages("en").daily.text("10", 10, text("en", hadithEvery(2)))).toBe("10 minutes a day, a new hadith every 2 days");
    expect(planReviseMessages("en").preview.daily("15", 15, text("en", ayat(3)))).toBe("15 minutes a day, about 3 new ayat a day");
  });
});

describe("the fallback to the words figure", () => {
  it("is used when the estimate carries no unit amount, as for a plan stored before D90", () => {
    for (const absent of [undefined, null]) {
      expect(text("ar", absent)).toBe("وحتى ٢٥ كلمة جديدة في اليوم");
      expect(text("en", absent)).toBe("up to 25 new words a day");
    }
  });

  it("is used when the unit amount is malformed (both or neither rate set)", () => {
    expect(text("ar", { unit: "ayah", perDay: 3, everyDays: 2 })).toBe("وحتى ٢٥ كلمة جديدة في اليوم");
    expect(text("en", { unit: "ayah", perDay: null, everyDays: null })).toBe("up to 25 new words a day");
  });

  it("keeps the Arabic noun agreement of the words figure", () => {
    expect(dailyAmountText("ar", { newWordsPerDay: 8 })).toBe("وحتى ٨ كلمات جديدة في اليوم");
    expect(dailyAmountText("en", { newWordsPerDay: 1 })).toBe("up to 1 new word a day");
  });
});

describe("the mock server's daily amount follows the rule of the real one", () => {
  const section = (kind: "surah" | "hadith", wordCount: number): CatalogSection => ({
    sectionId: `s-${kind}-${wordCount}`,
    ordinal: 1,
    kind,
    reference: "1",
    titleAr: "x",
    titleEn: "x",
    wordCount,
    passageCount: 1,
    paths: kind === "surah" ? ["quran"] : ["matn"],
  });

  it("gives one hadith every two days for one long hadith, and several ayat a day for a surah", () => {
    expect(mockDailyNew([section("hadith", 66)], 2, 66)).toEqual({ unit: "hadith", perDay: null, everyDays: 2 });
    expect(mockDailyNew([section("surah", 60), section("surah", 40)], 3, 100)).toEqual({ unit: "ayah", perDay: 7, everyDays: null });
  });

  it("has no amount when there is nothing to learn", () => {
    expect(mockDailyNew([], 3, 100)).toBeNull();
    expect(mockDailyNew([section("surah", 20)], 0, 20)).toBeNull();
    expect(mockDailyNew([section("surah", 20)], 2, 20, 20)).toBeNull();
  });
});
