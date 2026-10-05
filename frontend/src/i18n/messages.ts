// Shell strings, plus the catalogs of the screens built so far (auth-messages.ts, form-messages.ts).
// Arabic is verbatim where docs/UX.md, UI-tokens or UI-screens fix it; the rest is proposed copy (UI-tokens A7), so English wording is not sourced.
import { authAr, authEn, type AuthMessages } from "./auth-messages";
import { formAr, formEn, type FormMessages } from "./form-messages";
import { termsAr, termsEn, type TermsMessages } from "./terms-messages";

export type Locale = "ar" | "en";
export type Direction = "rtl" | "ltr";
export type TabId = "today" | "games" | "progress" | "settings";

export const LOCALES: readonly Locale[] = ["ar", "en"];
export const DEFAULT_LOCALE: Locale = "ar";

export function isLocale(value: unknown): value is Locale {
  return value === "ar" || value === "en";
}

export function directionForLocale(locale: Locale): Direction {
  return locale === "ar" ? "rtl" : "ltr";
}

export interface UiMessages {
  appName: string;
  documentTitle: (screen: string) => string;
  skipToContent: string;
  mainNavigationLabel: string;
  tabs: Record<TabId, string>;
  language: {
    groupLabel: string;
    arabicLabel: string;
    englishLabel: string;
    englishName: string; // contains the visible label (WCAG 2.5.3)
    changed: string;
  };
  backTo: (destination: string) => string;
  placeholder: { notBuilt: string };
  // Screen names: the H1 and the document title. Recovery, consent, start and the recovery code are still placeholders.
  screens: { login: string; register: string; recovery: string; consent: string; start: string; terms: string; recoveryCode: string };
  notFound: { title: string; body: string; action: string };
  error: { title: string; retry: string };
  server: { waking: string; retry: string; ready: string; busy: string };
  form: FormMessages;
  auth: AuthMessages;
  terms: TermsMessages;
}

const ar: UiMessages = {
  appName: "قطرة غيث",
  documentTitle: (screen) => `${screen} · قطرة غيث`,
  skipToContent: "انتقل إلى المحتوى",
  mainNavigationLabel: "التنقل الرئيسي",
  tabs: { today: "اليوم", games: "الألعاب", progress: "التقدم", settings: "الإعدادات" },
  language: {
    groupLabel: "اللغة",
    arabicLabel: "العربية",
    englishLabel: "EN",
    englishName: "English (EN)",
    changed: "تم تغيير اللغة إلى العربية",
  },
  backTo: (destination) => `رجوع إلى ${destination}`,
  placeholder: { notBuilt: "هذه الشاشة لم تُبنَ بعد، وستصل في دفعة لاحقة." },
  screens: {
    login: "الدخول",
    register: "إنشاء الحساب",
    recovery: "استرجاع الحساب",
    consent: "موافقة جديدة على الشروط",
    start: "ما هي خطتك؟",
    terms: "شروط الاستخدام وبيان الخصوصية",
    recoveryCode: "حفظ رمز الاسترجاع",
  },
  notFound: {
    title: "الصفحة غير موجودة",
    body: "لم نعثر على هذه الصفحة.",
    action: "الذهاب إلى الصفحة الرئيسية",
  },
  error: { title: "حدث خطأ غير متوقع. حاول مرة أخرى.", retry: "إعادة المحاولة" },
  server: {
    waking: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
    retry: "إعادة المحاولة",
    ready: "الخادم جاهز. يمكنك المحاولة الآن.",
    busy: "جارٍ التحميل",
  },
  form: formAr,
  auth: authAr,
  terms: termsAr,
};

const en: UiMessages = {
  appName: "Qatra",
  documentTitle: (screen) => `${screen} · Qatra`,
  skipToContent: "Skip to content",
  mainNavigationLabel: "Main navigation",
  tabs: { today: "Today", games: "Games", progress: "Progress", settings: "Settings" },
  language: {
    groupLabel: "Language",
    arabicLabel: "العربية",
    englishLabel: "EN",
    englishName: "English (EN)",
    changed: "Language changed to English",
  },
  backTo: (destination) => `Back to ${destination}`,
  placeholder: { notBuilt: "This screen has not been built yet. It arrives in a later batch." },
  screens: {
    login: "Log in",
    register: "Create an account",
    recovery: "Account recovery",
    consent: "Agree to the updated terms",
    start: "What is your plan?",
    terms: "Terms of use and privacy statement",
    recoveryCode: "Save your recovery code",
  },
  notFound: {
    title: "Page not found",
    body: "We could not find this page.",
    action: "Go to the home page",
  },
  error: { title: "Something unexpected happened. Try again.", retry: "Try again" },
  server: {
    waking: "Starting the free server, this may take about a minute.",
    retry: "Try again",
    ready: "The server is ready. You can try again now.",
    busy: "Loading",
  },
  form: formEn,
  auth: authEn,
  terms: termsEn,
};

const CATALOGS: Record<Locale, UiMessages> = { ar, en };

export function getMessages(locale: Locale): UiMessages {
  return CATALOGS[locale];
}
