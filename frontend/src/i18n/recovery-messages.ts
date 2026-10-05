// S-05 (account recovery) strings. Arabic is verbatim from docs/UI-screens.md S-05 and the patterns it cites; English is proposed (UI-tokens A7).
// The label and the helper of a field are separate strings: the spec joins them with a dash, which is never written on screen. The screen name
// (the H1 and the document title) is `screens.recovery` of messages.ts; the shared form lines (P-03 to P-08) come from form-messages.ts.
import type { Locale } from "./messages";

export interface RecoveryMessages {
  backDestination: string; // c1: the screen the arrow names, in "Back to {destination}"
  step1: {
    heading: string; // c3
    lead: string; // c4
    usernameLabel: string; // c5
    usernameRequired: string;
    codeLabel: string; // c6
    codeHelper: string;
    codeRequired: string;
    codeFormat: string; // O-11: nothing is sent for it
    notice: string; // c7
    submit: string; // c8
    submitting: string;
    submittingStatus: string; // the polite announcement while E06 is in flight
    remembered: string; // c9 text
    loginLink: string; // c9 link
  };
  step2: {
    heading: string; // c3'
    lead: string; // c4'
    passwordLabel: string; // c5'
    confirmationLabel: string;
    notice: string; // c7'
    submit: string; // c8'
    submitting: string;
    submittingStatus: string; // the polite announcement while E07 is in flight
  };
  invalid: string; // G-04: one message for every way E06 or E07 can refuse
  invalidHint: string; // P-10, after an uncertain E07 that the next attempt answers with the generic refusal
  uncertain: string; // P-10, E07 with no answer
  loginLink: string; // the link of the uncertain banner and of the hint
}

const ar: RecoveryMessages = {
  backDestination: "تصفّح الكتب",
  step1: {
    heading: "الخطوة ١ من ٣: التحقق من الرمز",
    lead: "أدخل اسم المستخدم ورمز الاسترجاع الذي حفظته عند التسجيل.",
    usernameLabel: "اسم المستخدم",
    usernameRequired: "أدخل اسم المستخدم.",
    codeLabel: "رمز الاسترجاع",
    codeHelper: "٣٢ خانة، مع الفواصل أو بدونها.",
    codeRequired: "أدخل رمز الاسترجاع.",
    codeFormat: "رمز الاسترجاع يتكوّن من ٣٢ خانة (أرقام وحروف من a إلى f).",
    notice: "بعد التحقق تكون أمامك ١٠ دقائق لتعيين كلمة مرور جديدة.",
    submit: "تحقق",
    submitting: "جارٍ التحقق…",
    submittingStatus: "جارٍ التحقق",
    remembered: "تذكّرت كلمة المرور؟",
    loginLink: "تسجيل الدخول",
  },
  step2: {
    heading: "الخطوة ٢ من ٣: كلمة مرور جديدة",
    lead: "تم التحقق. اختر كلمة مرور جديدة.",
    passwordLabel: "كلمة المرور الجديدة",
    confirmationLabel: "تأكيد كلمة المرور الجديدة",
    notice: "سيتوقف الرمز الحالي، وسنعرض لك رمزًا بديلًا مرة واحدة.",
    submit: "تعيين كلمة المرور",
    submitting: "جارٍ التعيين…",
    submittingStatus: "جارٍ التعيين",
  },
  invalid: "بيانات الاسترجاع غير صحيحة أو لم تعد صالحة.",
  invalidHint: "إن كنت قد غيّرت كلمة المرور قبل لحظات فجرّب الدخول بها.",
  uncertain: "تعذّر تأكيد النتيجة. إن كانت كلمة المرور قد تغيّرت فسجّل الدخول بها، وإلا أعد المحاولة. بعد الدخول يمكنك إنشاء رمز جديد من الإعدادات.",
  loginLink: "تسجيل الدخول",
};

const en: RecoveryMessages = {
  backDestination: "Browse books",
  step1: {
    heading: "Step 1 of 3: Verify your code",
    lead: "Enter your username and the recovery code you saved when you registered.",
    usernameLabel: "Username",
    usernameRequired: "Enter your username.",
    codeLabel: "Recovery code",
    codeHelper: "32 characters, with or without dashes.",
    codeRequired: "Enter the recovery code.",
    codeFormat: "The recovery code has 32 characters (digits and letters a to f).",
    notice: "After verification you have 10 minutes to set a new password.",
    submit: "Verify",
    submitting: "Verifying…",
    submittingStatus: "Verifying",
    remembered: "Remembered your password?",
    loginLink: "Log in",
  },
  step2: {
    heading: "Step 2 of 3: New password",
    lead: "Verified. Choose a new password.",
    passwordLabel: "New password",
    confirmationLabel: "Confirm new password",
    notice: "Your current code will stop working and we will show you a replacement once.",
    submit: "Set password",
    submitting: "Setting…",
    submittingStatus: "Setting the password",
  },
  invalid: "The recovery details are not correct or are no longer valid.",
  invalidHint: "If you changed your password a moment ago, try logging in with it.",
  uncertain:
    "We could not confirm the result. If your password changed, log in with it; otherwise try again. After you log in you can create a new code in Settings.",
  loginLink: "Log in",
};

const CATALOGS: Record<Locale, RecoveryMessages> = { ar, en };

export function recoveryMessages(locale: Locale): RecoveryMessages {
  return CATALOGS[locale];
}
