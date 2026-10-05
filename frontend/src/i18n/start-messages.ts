// Strings of S-08, the start and goal screen (UI-screens Batch 2, section 3 and 4). Arabic is verbatim from the S-08 table and states;
// English is proposed (UI-tokens A7). The goal sentence follows UI-design 1.1; its wording is proposed copy (O-60).
import type { Locale } from "./messages";

// The next thing the learner has to choose, in the order of the cascade. The helper under the primary button names it (O-59).
export type NextStep = "category" | "book" | "juz" | "surah" | "hadith" | "section";

// Between the first and the last ordinal of a group: an en dash, written as an escape because the source rules keep literal dashes out of the text.
const RANGE_DASH = "\u2013";

// The noun of a group row: «الأحاديث» for a hadith book, «الأقسام» for any other.
export type GroupKind = "hadith" | "section";

export interface SentenceParts {
  what: string; // what is memorized: section names, "all sections" or "{n} of {m} surahs"
  book: string;
  edition: string;
  category: string;
  learn: string; // "" or the hadith paths clause, already ending in its separator
  minutes: string; // "10 minutes"
  deadline: string; // the date clause or "no set date"
}

export interface StartMessages {
  subtitle: string; // c3
  planOverview: string; // name of S-12 for the close control, shown when a plan is active (O-31)
  openChat: { text: string; action: string }; // c4
  category: { legend: string }; // c5
  books: { legend: string; detail: (author: string, edition: string) => string }; // c7
  juz: { legend: string; title: (formattedNumber: string) => string }; // c6 (D88)
  noMaterial: string; // G-27
  list: {
    legends: { surah: string; hadith: string; section: string }; // c8
    // D88: the group rows of a book of more than 10 sections. `kind` is the noun of the list: hadiths or sections.
    groupLabel: (kind: GroupKind, first: string, last: string) => string;
    // A group of one section (the last group of a book of 41) is named by that section: «الحديث ٤١», not a range.
    singleLabel: (kind: GroupKind, formattedNumber: string) => string;
    groupCount: (kind: GroupKind, count: number, formattedCount: string) => string;
    customize: string;
    customizeName: (groupLabel: string) => string;
  };
  count: { none: string; some: (n: string, m: string) => string; all: (m: string) => string }; // c9
  tools: { selectAll: string; clear: string };
  chips: { group: string; remove: (title: string) => string; removed: (title: string, count: string) => string }; // c10
  limit: string;
  minutes: { legend: string; label: (formattedMinutes: string, minutes: number) => string }; // c11
  date: { label: string; helper: string; clear: string; past: string }; // c12
  paths: { legend: string; matn: string; sanad: string; grade: string; helper: string; added: string }; // c13
  goal: {
    label: string;
    counter: (n: string, max: string) => string;
    helper: string;
    restore: string;
    restored: string;
    placeholder: string;
    empty: string;
    tooLong: string;
    updated: string;
  }; // c14 to c17
  notice: string; // c18, P-15
  action: { start: string; helper: string; next: Record<NextStep, string> }; // c19
  announce: { listAppeared: (legend: string) => string };
  sentence: {
    build: (parts: SentenceParts) => string;
    all: string;
    someOf: (n: string, m: string, kind: "surah" | "hadith") => string;
    names: (names: readonly string[]) => string;
    pathNames: Record<"matn" | "sanad" | "grade", string>;
    learn: (paths: string) => string;
    noDate: string;
    byDate: (date: string) => string;
  };
}

const AR_PLURALS = new Intl.PluralRules("ar");

const startAr: StartMessages = {
  subtitle: "اختر ما تريد حفظه ووقتك اليومي، ثم نكمل الخطة معًا.",
  planOverview: "الخطة الكبرى",
  openChat: { text: "لديك محادثة خطة لم تعتمدها بعد. إن بدأت محادثة جديدة فستحلّ محلها.", action: "متابعة المحادثة" },
  category: { legend: "الباب" },
  books: { legend: "الكتاب", detail: (author, edition) => `${author} · ${edition}` },
  juz: { legend: "الجزء", title: (number) => `الجزء ${number}` },
  noMaterial: "لا تتوفر مادة",
  list: {
    legends: { surah: "السور", hadith: "الأحاديث", section: "الأقسام" },
    groupLabel: (kind, first, last) => `${kind === "hadith" ? "الأحاديث" : "الأقسام"} ${first}${RANGE_DASH}${last}`,
    singleLabel: (kind, number) => `${kind === "hadith" ? "الحديث" : "القسم"} ${number}`,
    // The noun follows the Arabic number: dual for 2, plural for 3 to 10, the accusative singular from 11.
    groupCount: (kind, count, formatted) => {
      const hadith = kind === "hadith";
      if (count === 1) return hadith ? "حديث واحد" : "قسم واحد";
      if (count === 2) return hadith ? "حديثان" : "قسمان";
      if (count <= 10) return `${formatted} ${hadith ? "أحاديث" : "أقسام"}`;
      return `${formatted} ${hadith ? "حديثًا" : "قسمًا"}`;
    },
    customize: "تخصيص",
    customizeName: (label) => `تخصيص ${label}`,
  },
  count: {
    none: "لم تختر شيئًا بعد",
    some: (n, m) => `تم اختيار ${n} من ${m}`,
    all: (m) => `تم اختيار الكل (${m})`,
  },
  tools: { selectAll: "تحديد الكل", clear: "مسح الاختيار" },
  chips: {
    group: "الأقسام المختارة",
    remove: (title) => `إزالة ${title}`,
    removed: (title, count) => `أُزيل ${title}. ${count}`,
  },
  limit: "يمكن اختيار ٦٠ قسمًا على الأكثر.",
  minutes: {
    legend: "وقتك اليومي",
    // The noun follows the Arabic number: plural for 3 to 10, the accusative singular from 11 (UI-screens c11: 5, 10 and 15 minutes).
    label: (formatted, minutes) => (AR_PLURALS.select(minutes) === "few" ? `${formatted} دقائق` : `${formatted} دقيقة`),
  },
  date: {
    label: "الموعد المفضل (اختياري)",
    helper: "اختياري. اتركه فارغًا إن لم يكن لديك موعد.",
    clear: "مسح الموعد",
    past: "اختر موعدًا من اليوم فصاعدًا.",
  },
  paths: {
    legend: "ما تريد تعلمه",
    matn: "متن",
    sanad: "سند",
    grade: "الدرجة",
    helper: "يبقى مسار واحد على الأقل.",
    added: "أضيف خيار «ما تريد تعلمه»",
  },
  goal: {
    label: "الهدف والموعد",
    counter: (n, max) => `${n}/${max}`,
    helper: "لا تكتب اسمك أو أي بيانات شخصية.",
    restore: "استعادة الجملة المقترحة",
    restored: "تمت استعادة الجملة",
    placeholder: "اكتب هدفك هنا، أو اختر ما تريد حفظه لنكتب لك جملة مقترحة.",
    empty: "اكتب هدفك أو استعد الجملة المقترحة.",
    tooLong: "الهدف حتى ٥٠٠ حرف.",
    updated: "تم تحديث الجملة المقترحة",
  },
  notice:
    "تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي يستقبل وصف هدفك وخيارات الخطة، وعند التعديل ملخص تعلمك وإجاباتك، تحت معرّف مؤقت لا يكشف حسابك؛ وتُحسب الأرقام بمحرك القواعد داخل التطبيق.",
  action: {
    start: "ابدأ المحادثة",
    helper: "تسبقها أسئلة قصيرة لتحديد نقطة البداية، ويمكنك تجاوزها.",
    next: {
      category: "اختر الباب أولًا.",
      juz: "اختر الجزء.",
      book: "اختر الكتاب.",
      surah: "اختر سورة واحدة على الأقل.",
      hadith: "اختر حديثًا واحدًا على الأقل.",
      section: "اختر قسمًا واحدًا على الأقل.",
    },
  },
  announce: { listAppeared: (legend) => `ظهرت قائمة: ${legend}` },
  sentence: {
    build: ({ what, book, edition, category, learn, minutes, deadline }) =>
      `أريد حفظ ${what} من ${book} (${edition}) من باب ${category}، ${learn}بمعدل ${minutes} يوميًا، ${deadline}، بواجهة العربية.`,
    all: "كل الأقسام",
    someOf: (n, m, kind) => `${n} من ${m} ${kind === "surah" ? "سورة" : "حديث"}`,
    names: (names) => names.join(" و"),
    pathNames: { matn: "المتن", sanad: "السند", grade: "الدرجة" },
    learn: (paths) => `وأتعلم ${paths}، `,
    noDate: "دون موعد محدد",
    byDate: (date) => `وأن أنهيه بحلول ${date}`,
  },
};

const startEn: StartMessages = {
  subtitle: "Choose what to memorize and your daily time, then we finish the plan together.",
  planOverview: "Plan overview",
  openChat: {
    text: "You have an unconfirmed plan conversation. Starting a new one replaces it.",
    action: "Continue the conversation",
  },
  category: { legend: "Category" },
  books: { legend: "Book", detail: (author, edition) => `${author} · ${edition}` },
  juz: { legend: "Juz'", title: (number) => `Juz' ${number}` },
  noMaterial: "No material is available",
  list: {
    legends: { surah: "Surahs", hadith: "Hadiths", section: "Sections" },
    groupLabel: (kind, first, last) => `${kind === "hadith" ? "Hadiths" : "Sections"} ${first}${RANGE_DASH}${last}`,
    singleLabel: (kind, number) => `${kind === "hadith" ? "Hadith" : "Section"} ${number}`,
    groupCount: (kind, count, formatted) => {
      const noun = kind === "hadith" ? "hadith" : "section";
      return `${formatted} ${count === 1 ? noun : `${noun}s`}`;
    },
    customize: "Customize",
    customizeName: (label) => `Customize ${label}`,
  },
  count: {
    none: "Nothing selected yet",
    some: (n, m) => `${n} of ${m} selected`,
    all: (m) => `All ${m} selected`,
  },
  tools: { selectAll: "Select all", clear: "Clear selection" },
  chips: {
    group: "Selected sections",
    remove: (title) => `Remove ${title}`,
    removed: (title, count) => `${title} removed. ${count}`,
  },
  limit: "You can choose at most 60 sections.",
  minutes: { legend: "Daily time", label: (formatted) => `${formatted} minutes` },
  date: {
    label: "Preferred date (optional)",
    helper: "Optional. Leave empty if you have no date.",
    clear: "Clear the date",
    past: "Choose a date from today onward.",
  },
  paths: {
    legend: "What you want to learn",
    matn: "Matn",
    sanad: "Sanad",
    grade: "Grade",
    helper: "At least one path stays selected.",
    added: "The option \"What you want to learn\" was added",
  },
  goal: {
    label: "Goal and date",
    counter: (n, max) => `${n}/${max}`,
    helper: "Do not type your name or personal data.",
    restore: "Restore the suggested sentence",
    restored: "The sentence was restored",
    placeholder: "Write your goal here, or choose what to memorize and we suggest a sentence.",
    empty: "Write your goal or restore the suggested sentence.",
    tooLong: "The goal can be up to 500 characters.",
    updated: "The suggested sentence was updated",
  },
  notice:
    "Your plan is built and revised in a conversation with an AI assistant that receives the description of your goal and the plan options, and, when you revise, a summary of your learning and answers, under a temporary identifier that does not reveal your account; the numbers are computed by the rules engine inside the app.",
  action: {
    start: "Start the conversation",
    helper: "Short questions to find your starting point come first; you can skip them.",
    next: {
      category: "Choose a category first.",
      juz: "Choose a juz'.",
      book: "Choose a book.",
      surah: "Choose at least one surah.",
      hadith: "Choose at least one hadith.",
      section: "Choose at least one section.",
    },
  },
  announce: { listAppeared: (legend) => `A list appeared: ${legend}` },
  sentence: {
    build: ({ what, book, edition, category, learn, minutes, deadline }) =>
      `I want to memorize ${what} of ${book} (${edition}) from ${category}, ${learn}at ${minutes} a day, ${deadline}, with the English interface.`,
    all: "all sections",
    someOf: (n, m, kind) => `${n} of ${m} ${kind === "surah" ? "surahs" : "hadiths"}`,
    names: (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`),
    pathNames: { matn: "matn", sanad: "sanad", grade: "grade" },
    learn: (paths) => `learning ${paths}, `,
    noDate: "with no set date",
    byDate: (date) => `and finish by ${date}`,
  },
};

const CATALOGS: Record<Locale, StartMessages> = { ar: startAr, en: startEn };

export function getStartMessages(locale: Locale): StartMessages {
  return CATALOGS[locale];
}
