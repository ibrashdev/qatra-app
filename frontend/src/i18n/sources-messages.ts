// S-25 (sources) strings. Arabic is verbatim from docs/UI-screens.md S-25 section 3; English is proposed (UI-tokens A7).
// The fixed notice (c2) is the one of S-07 and comes from catalog-messages.ts. S-25 c8 joins a label and a sentence with a dash in the spec;
// they are two elements here, so no dash is written (D80).
import type { CatalogEdition } from "@/lib/api/types";
import type { Locale } from "./messages";

export interface SourcesMessages {
  screenName: string; // c1, the H1 and the document title
  category: string; // c4; {label}
  reference: Record<CatalogEdition["contentFormat"], string>; // c5, c6
  takhrij: string; // c7
  unavailable: { chip: string; text: string; start: string }; // c8
  empty: string; // c9
}

const ar: SourcesMessages = {
  screenName: "المصادر",
  category: "الباب: {label}",
  reference: {
    quran: "طريقة المرجع: السورة والآية، مع رابط مرجعي بجانب النص بدل رقم الصفحة.",
    hadith_collection: "طريقة المرجع: رقم الحديث، مع رابط مرجعي بجانب النص بدل رقم الصفحة.",
  },
  takhrij:
    "التخريج والدرجة منقولان كما وردا في سجل HadeethEnc، ويُعرضان موسومين بأنهما من سجله، دون تعديل أو إضافة. وحين لا تنسب الطبعة الحديث إلى الصحيحين ولا تذكر درجته يظهر بجانبه تنبيه ثابت.",
  unavailable: { chip: "غير متاح", text: "هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.", start: "ابدأ خطتك" },
  empty: "لا توجد مصادر منشورة الآن.",
};

const en: SourcesMessages = {
  screenName: "Sources",
  category: "Category: {label}",
  reference: {
    quran: "Reference: surah and ayah, with a reference link beside the text instead of a page number.",
    hadith_collection: "Reference: hadith number, with a reference link beside the text instead of a page number.",
  },
  takhrij:
    "The takhrij and the grade are taken as recorded in the HadeethEnc record and are shown labelled as coming from it, without change or addition. When the edition neither attributes a hadith to the Sahihayn nor gives its grade, a fixed notice appears beside it.",
  unavailable: { chip: "Unavailable", text: "This edition is no longer available. You can start a plan on another edition.", start: "Start your plan" },
  empty: "No sources are published right now.",
};

const CATALOGS: Record<Locale, SourcesMessages> = { ar, en };

export function sourcesMessages(locale: Locale): SourcesMessages {
  return CATALOGS[locale];
}
