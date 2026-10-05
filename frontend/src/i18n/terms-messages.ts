// S-03 strings that every page may need: the name of the screen it returns to (the back control of the loading and error views carries it
// too) and the error banner. The text of the page itself is in terms-text.ts and loads with the route.
import type { TermsOpener } from "@/lib/nav/terms-opener";

export interface TermsMessages {
  destinations: Record<TermsOpener, string>; // c1: "Back to {destination}"
  unavailable: string; // the error banner when the route fails to load
}

export const termsAr: TermsMessages = {
  destinations: { register: "إنشاء الحساب", consent: "الموافقة", home: "الصفحة الرئيسية" },
  unavailable: "تعذّر فتح شروط الاستخدام وبيان الخصوصية. تحقّق من الاتصال ثم أعد المحاولة.",
};

export const termsEn: TermsMessages = {
  destinations: { register: "Create account", consent: "Consent", home: "Home" },
  unavailable: "The terms of use and privacy statement could not be opened. Check your connection and try again.",
};
