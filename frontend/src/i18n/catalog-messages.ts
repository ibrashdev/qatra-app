// S-07 (public catalog) strings, and the notice that S-25 shares with it. Arabic is verbatim from docs/UI-screens.md S-07 section 3; English is proposed (UI-tokens A7).
// The retry label, the loading line and the generic service errors come from messages.ts (server.retry, server.busy, form.*).
import type { Path } from "@/lib/api/types";
import type { Locale } from "./messages";

// A number with the text it is written in (the digits of the interface language, UI-tokens 3.4); the count picks the plural form.
export interface Counted {
  count: number;
  formatted: string;
}

export interface CatalogMessages {
  screenName: string; // c3, the H1 and the document title
  intro: string; // c4
  notice: string; // c5, also S-25 c2
  createAccount: string; // c2
  logIn: string; // c2
  facts: (sections: Counted, words: Counted) => string; // c8
  pathsLine: (labels: string) => string; // c9
  pathLabels: Record<Path, string>; // O-18, proposed
  listSeparator: string; // between path labels
  sectionsToggle: (formatted: string) => string; // c10, the name of the disclosure
  rowCounts: (words: Counted, passages: Counted) => string; // c11, after the title
  empty: { title: string; text: string };
}

const ARABIC_PLURALS = new Intl.PluralRules("ar");
const ENGLISH_PLURALS = new Intl.PluralRules("en");

// Arabic counted nouns: one and two have no figure; 3 to 10 take the plural, 11 to 99 the accusative singular, the rest (and zero) the plain singular.
interface ArabicForms {
  one: string;
  two: string;
  few: (formatted: string) => string;
  many: (formatted: string) => string;
  other: (formatted: string) => string;
}

function arabicCounted({ count, formatted }: Counted, forms: ArabicForms): string {
  switch (ARABIC_PLURALS.select(count)) {
    case "one":
      return forms.one;
    case "two":
      return forms.two;
    case "few":
      return forms.few(formatted);
    case "many":
      return forms.many(formatted);
    default:
      return forms.other(formatted);
  }
}

const arabicSections = (value: Counted): string =>
  arabicCounted(value, {
    one: "قسم واحد",
    two: "قسمان",
    few: (n) => `${n} أقسام`,
    many: (n) => `${n} قسمًا`,
    other: (n) => `${n} قسم`,
  });

const arabicWords = (value: Counted): string =>
  arabicCounted(value, {
    one: "كلمة واحدة",
    two: "كلمتان",
    few: (n) => `${n} كلمات`,
    many: (n) => `${n} كلمةً`,
    other: (n) => `${n} كلمة`,
  });

const arabicPassages = (value: Counted): string =>
  arabicCounted(value, {
    one: "مقطع واحد",
    two: "مقطعان",
    few: (n) => `${n} مقاطع`,
    many: (n) => `${n} مقطعًا`,
    other: (n) => `${n} مقطع`,
  });

const englishCounted = ({ count, formatted }: Counted, singular: string, plural: string): string =>
  `${formatted} ${ENGLISH_PLURALS.select(count) === "one" ? singular : plural}`;

const ar: CatalogMessages = {
  screenName: "تصفّح الكتب",
  intro: "اطّلع على الكتب والأقسام المتاحة قبل إنشاء حسابك. لا يُعرض هنا نص الكتاب؛ يبدأ التعلم بعد إنشاء الحساب.",
  notice: "يعرض التطبيق الكتاب كما هو في نسخته الموثقة للحفظ، دون إضافة أو شرح.",
  createAccount: "إنشاء حساب",
  logIn: "تسجيل الدخول",
  facts: (sections, words) => `${arabicSections(sections)} · ${arabicWords(words)}`,
  pathsLine: (labels) => `المسارات المتاحة: ${labels}`,
  pathLabels: { quran: "النص القرآني", matn: "المتن", sanad: "السند", grade: "الدرجة" },
  listSeparator: "، ",
  sectionsToggle: (formatted) => `الأقسام (${formatted})`,
  rowCounts: (words, passages) => `${arabicWords(words)} · ${arabicPassages(passages)}`,
  empty: { title: "لا توجد كتب متاحة الآن.", text: "ستظهر هنا الكتب فور نشرها." },
};

const en: CatalogMessages = {
  screenName: "Browse books",
  intro: "See the books and sections available before you create an account. The text of the books is not shown here; learning starts after you create an account.",
  notice: "The app shows the book as it is in its verified edition for memorization, without additions or explanation.",
  createAccount: "Create an account",
  logIn: "Log in",
  facts: (sections, words) => `${englishCounted(sections, "section", "sections")} · ${englishCounted(words, "word", "words")}`,
  pathsLine: (labels) => `Available paths: ${labels}`,
  pathLabels: { quran: "Quran text", matn: "Matn", sanad: "Sanad", grade: "Grade" },
  listSeparator: ", ",
  sectionsToggle: (formatted) => `Sections (${formatted})`,
  rowCounts: (words, passages) => `${englishCounted(words, "word", "words")} · ${englishCounted(passages, "passage", "passages")}`,
  empty: { title: "No books are available right now.", text: "Books will appear here as soon as they are published." },
};

const CATALOGS: Record<Locale, CatalogMessages> = { ar, en };

export function catalogMessages(locale: Locale): CatalogMessages {
  return CATALOGS[locale];
}
