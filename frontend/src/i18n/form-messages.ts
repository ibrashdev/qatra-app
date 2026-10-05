// Strings the forms of Batch 1 share (UI-screens P-03 to P-08). Arabic is verbatim from docs/UI-screens.md; English is proposed (UI-tokens A7).
import type { ConfirmationRule, PasswordRule } from "@/lib/auth/account-rules";

export interface FormMessages {
  errorSummary: (count: number, formatted: string) => string; // P-03; `formatted` is the count already written in the digits of the language
  dismiss: string; // proposed: no source names the dismiss control of a banner
  showPassword: string; // P-08
  hidePassword: string;
  passwordRules: Record<PasswordRule, string>; // P-08, for a password that is being chosen (S-02, S-05 step 2)
  confirmationRules: Record<ConfirmationRule, string>;
  termsUpdated: string; // E03 and E05 `terms_required` when the server wants a version this build has not shown (O-09)
  offline: string; // P-05
  backOnline: string;
  throttleSeconds: (seconds: string) => string; // P-06, up to 60 s
  throttleClock: string; // P-06, longer; {time} is filled with a left-to-right mm:ss
  throttleOver: string;
  stillProcessing: string;
  internal: string; // P-07
  unavailable: string;
  forbiddenOrigin: string;
  reloadPage: string;
}

const ARABIC_PLURALS = new Intl.PluralRules("ar");

export const formAr: FormMessages = {
  // The noun follows the Arabic number: dual with no figure, "errors" for 3 to 10, the accusative singular for 11 to 99, the plain
  // singular from 100. The summary shows from two errors on, so zero and one are never asked for and read like the last form.
  errorSummary: (count, formatted) => {
    switch (ARABIC_PLURALS.select(count)) {
      case "two":
        return "يوجد خطآن في النموذج";
      case "few":
        return `يوجد ${formatted} أخطاء في النموذج`;
      case "many":
        return `يوجد ${formatted} خطأً في النموذج`;
      default:
        return `يوجد ${formatted} خطأ في النموذج`;
    }
  },
  dismiss: "إغلاق التنبيه",
  showPassword: "إظهار كلمة المرور",
  hidePassword: "إخفاء كلمة المرور",
  passwordRules: {
    empty: "أدخل كلمة المرور.",
    password_min_chars: "كلمة المرور ١٥ حرفًا على الأقل.",
    password_max_bytes: "كلمة المرور أطول من الحد المسموح (٧٢ بايت). اختصرها قليلًا؛ الحرف العربي الواحد يُحتسب بايتين.",
  },
  confirmationRules: { empty: "أكّد كلمة المرور.", mismatch: "كلمتا المرور غير متطابقتين." },
  termsUpdated: "تحدّثت الشروط. أعد تحميل الصفحة لقراءة الإصدار الأحدث.",
  offline: "لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.",
  backOnline: "عاد الاتصال.",
  throttleSeconds: (seconds) => `محاولات كثيرة. انتظر ${seconds} ثانية ثم أعد المحاولة.`,
  throttleClock: "محاولات كثيرة. يمكنك المحاولة بعد {time}.",
  throttleOver: "يمكنك المحاولة الآن.",
  stillProcessing: "ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.",
  internal: "حدث خطأ غير متوقع. حاول مرة أخرى.",
  unavailable: "الخدمة غير متاحة مؤقتًا. حاول بعد قليل.",
  forbiddenOrigin: "تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.",
  reloadPage: "إعادة تحميل الصفحة",
};

export const formEn: FormMessages = {
  errorSummary: (_count, formatted) => `There are ${formatted} errors in the form`,
  dismiss: "Dismiss message",
  showPassword: "Show password",
  hidePassword: "Hide password",
  passwordRules: {
    empty: "Enter a password.",
    password_min_chars: "The password must be at least 15 characters.",
    password_max_bytes: "The password is longer than the allowed limit (72 bytes). Shorten it a little; each Arabic letter counts as two bytes.",
  },
  confirmationRules: { empty: "Confirm the password.", mismatch: "The two passwords do not match." },
  termsUpdated: "The terms were updated. Reload the page to read the latest version.",
  offline: "There is no network connection. Check your connection and try again.",
  backOnline: "The connection is back.",
  throttleSeconds: (seconds) => `Too many attempts. Wait ${seconds} seconds and try again.`,
  throttleClock: "Too many attempts. You can try again in {time}.",
  throttleOver: "You can try again now.",
  stillProcessing: "We are still processing your request; this may take a moment.",
  internal: "Something unexpected happened. Try again.",
  unavailable: "The service is temporarily unavailable. Try again shortly.",
  forbiddenOrigin: "The request could not be completed. Reload the page and try again.",
  reloadPage: "Reload page",
};
