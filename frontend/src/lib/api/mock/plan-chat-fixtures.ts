// Synthetic texts and trigger names for the mock plan conversation (E31 to E34, D75). Placeholders only: no source text, no real plan content.
import type { QuickReply, QuickReplyCode } from "../types";

// The fixed assistant messages. The refusal is the D26 sentence verbatim (Plan-conversation 2.4); the others are the proposed lines of UI-screens S-34.
export const MOCK_REFUSAL = {
  ar: "نعتذر، التطبيق مخصص لحفظ الكتب كما هي ولا يقدم فتوى أو شرحًا. للفتوى أو الشرح يرجى مراجعة أهل العلم والاختصاص.",
  en: "Sorry, the app is for memorizing books as they are and does not give fatwas or explanations. For a fatwa or an explanation, please consult qualified scholars.",
} as const;

export const MOCK_REDIRECT = {
  ar: "يمكنني مساعدتك في خطة الحفظ فقط: المدة والوقت اليومي والنطاق والترتيب والمراجعات.",
  en: "I can only help with your memorization plan: duration, daily time, scope, order and reviews.",
} as const;

export const MOCK_FALLBACK = {
  ar: "المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.",
  en: "The assistant is unavailable right now; you can continue with the options below.",
} as const;

export const MOCK_PROPOSAL_TEXT = {
  ar: "هذه خطة مقترحة. راجع البطاقة أدناه أو اختر تعديلًا.",
  en: "Here is a proposed plan. Review the card below or choose a change.",
} as const;

export const MOCK_UPDATED_TEXT = {
  ar: "حدّثت الاقتراح. راجع البطاقة الجديدة.",
  en: "I updated the proposal. Review the new card.",
} as const;

export const MOCK_NO_CHANGE_TEXT = {
  ar: "لم يتغير شيء. جرّب أحد الخيارات أدناه.",
  en: "Nothing changed. Try one of the options below.",
} as const;

export const MOCK_CHANGED_ELSEWHERE_TEXT = {
  ar: "تغيّر الاقتراح. راجع البطاقة الجديدة ثم أكّد.",
  en: "The proposal changed. Review the new card, then confirm.",
} as const;

export const MOCK_QUICK_REPLIES: Readonly<Record<QuickReplyCode, QuickReply>> = {
  fewer_minutes: { code: "fewer_minutes", labelAr: "أقل دقائق", labelEn: "Fewer minutes" },
  more_minutes: { code: "more_minutes", labelAr: "دقائق أكثر", labelEn: "More minutes" },
  smaller_scope: { code: "smaller_scope", labelAr: "هدف أصغر", labelEn: "Smaller goal" },
  later_date: { code: "later_date", labelAr: "موعد أبعد", labelEn: "Later date" },
  no_date: { code: "no_date", labelAr: "دون موعد محدد", labelEn: "No set date" },
  order_book: { code: "order_book", labelAr: "ترتيب الكتاب", labelEn: "Book order" },
  order_reverse: { code: "order_reverse", labelAr: "الترتيب العكسي للقرآن", labelEn: "Reverse order (Quran)" },
  paths_matn_only: { code: "paths_matn_only", labelAr: "المتن فقط", labelEn: "Matn only" },
  paths_all: { code: "paths_all", labelAr: "كل المسارات", labelEn: "All paths" },
  confirm: { code: "confirm", labelAr: "اعتماد", labelEn: "Confirm" },
};

// Words in the goal text of E31 that make the mock answer a documented outcome of E34 or E31. Synthetic, like the names of MOCK_LOGINS.
export const MOCK_CHAT_GOALS = {
  editionGone: "edition_gone_goal_01", // E31 422 edition_not_available
  stale: "stale_goal_01", // the first E34 answers 409 proposal_stale with a newer proposal
  planMoved: "plan_moved_goal_01", // a revision: E34 answers 409 plan_version
  race: "race_goal_01", // the first E34 answers 409 active_plan_conflict
  inactive: "inactive_goal_01", // E34 answers 409 plan_not_active
} as const;

// Words in the free text of E32 that make the mock answer a documented failure.
export const MOCK_CHAT_TEXTS = {
  throttled: "throttled_message_01", // 429 throttled, retryAfterSec 20
  unavailable: "unavailable_message_01", // 503 unavailable
  internal: "internal_message_01", // 500 internal
} as const;

// A reviewed word list stands in for the guard (Plan-conversation 2.4 step 1); the real list lives on the server.
export const MOCK_RELIGIOUS_WORDS = /fatwa|ruling|meaning|explain|translate|halal|haram|tafsir|فتوى|حكم|تفسير|معنى|شرح|ترجمة|حلال|حرام/i;
export const MOCK_OUT_OF_SCOPE_WORDS = /weather|football|recipe|joke|طقس|كرة|وصفة|نكتة/i;
