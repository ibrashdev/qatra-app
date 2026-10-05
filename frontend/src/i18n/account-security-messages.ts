// S-23, S-24 and S-27 strings (change password, regenerate the recovery code, delete account). Arabic is verbatim from docs/UI-screens.md (the three
// screens and P-27); English is proposed (UI-tokens A7). Where the spec joins a label to its helper, or a heading to its list, with a dash, the pieces
// are separate strings here: the dash is never written on screen. The shared form lines (P-03 to P-08) come from form-messages.ts.
import type { Locale } from "./messages";

export interface AccountSecurityMessages {
  backDestination: string; // c1: the screen the arrow names, in "Back to {destination}"
  currentPassword: {
    label: string; // P-27
    required: string;
    invalid: string; // G-04, re-authentication
  };
  loginLink: string; // the link of the uncertain banners
  password: {
    screenName: string; // S-23: the H1 and the document title
    notice: string; // c2
    newLabel: string; // c4
    newHelper: string;
    confirmationLabel: string; // c5
    submit: string; // c6
    submitting: string;
    submittingStatus: string; // the polite announcement while E09 is in flight
    uncertain: string; // P-10, E09 with no answer
  };
  recoveryCode: {
    screenName: string; // S-24
    notice: string; // c2
    submit: string; // c4
    submitting: string;
    submittingStatus: string; // while E08 is in flight
    uncertain: string; // P-10, E08 with no answer
  };
  deleteAccount: {
    screenName: string; // S-27
    warning: string; // c2
    effectsHeading: string; // c3
    effects: readonly string[];
    knowHeading: string; // c4
    know: readonly string[];
    privacyLink: string; // the link to S-26, on its own line
    acknowledgment: string; // c6: the label is exactly the sentence
    acknowledgmentRequired: string; // the error at c6
    submit: string; // c7
    submitting: string;
    submittingStatus: string; // while E13 is in flight
    cancel: string; // c8
    notDeleted: string; // E13 `503`: the account is intact
    uncertain: string; // P-10, E13 with no answer
  };
}

const ar: AccountSecurityMessages = {
  backDestination: "الإعدادات",
  currentPassword: {
    label: "كلمة المرور الحالية",
    required: "أدخل كلمة المرور الحالية.",
    invalid: "كلمة المرور الحالية غير صحيحة.",
  },
  loginLink: "تسجيل الدخول",
  password: {
    screenName: "تغيير كلمة المرور",
    notice: "ستبقى مسجّلًا الدخول في هذا الجهاز، وتنتهي جلسات هذا الحساب على الأجهزة الأخرى.",
    newLabel: "كلمة المرور الجديدة",
    newHelper: "١٥ حرفًا على الأقل. يمكنك استخدام عبارة طويلة.",
    confirmationLabel: "تأكيد كلمة المرور الجديدة",
    submit: "تغيير كلمة المرور",
    submitting: "جارٍ التغيير…",
    submittingStatus: "جارٍ التغيير",
    uncertain: "تعذّر تأكيد النتيجة. إن انتهت جلستك فسجّل الدخول بكلمة المرور الجديدة؛ وإلا أعد المحاولة.",
  },
  recoveryCode: {
    screenName: "إعادة توليد الرمز",
    notice: "سيتوقف رمز الاسترجاع الحالي عن العمل فور إنشاء الرمز الجديد، ولن نعرضه لك مرة أخرى. يظهر الرمز الجديد مرة واحدة فقط.",
    submit: "إعادة توليد الرمز",
    submitting: "جارٍ الإنشاء…",
    submittingStatus: "جارٍ الإنشاء",
    uncertain: "تعذّر تأكيد النتيجة. أعد المحاولة؛ كل محاولة ناجحة تستبدل الرمز السابق.",
  },
  deleteAccount: {
    screenName: "حذف الحساب",
    warning: "حذف الحساب فوري ونهائي، ولا يمكن التراجع عنه.",
    effectsHeading: "ما الذي سيُحذف؟",
    effects: ["حسابك وإعداداتك وسجل موافقتك على الشروط.", "خططك وجلساتك وإجاباتك وتقدمك.", "رسائل محادثة الخطة مع المساعد.", "رمز الاسترجاع وجلسات الدخول على كل الأجهزة."],
    knowHeading: "ما يجب أن تعرفه",
    know: [
      "لا تُحفظ إجاباتك على هذا الجهاز؛ كل ما سُجّل محفوظ في حسابك السحابي وسيُحذف معه.",
      "لا نحتفظ بنسخة قابلة للتنزيل من بياناتك، ولا يمكن استرجاعها بعد الحذف.",
      "قد تبقى نسخ احتياطية داخلية لدى مزود الخدمة مدة تحددها خطته؛ التفاصيل في «بيان الخصوصية».",
      "يحتاج الحذف إلى اتصال بالشبكة.",
    ],
    privacyLink: "بيان الخصوصية",
    acknowledgment: "أفهم أن حذف حسابي نهائي ولا يمكن التراجع عنه",
    acknowledgmentRequired: "أكّد أنك تفهم أن الحذف نهائي قبل المتابعة.",
    submit: "حذف حسابي نهائيًا",
    submitting: "جارٍ الحذف…",
    submittingStatus: "جارٍ الحذف",
    cancel: "إلغاء",
    notDeleted: "لم يُحذف حسابك.",
    uncertain: "تعذّر تأكيد النتيجة. إن كان الحساب قد حُذف فستنتهي جلستك؛ وإلا أعد المحاولة.",
  },
};

const en: AccountSecurityMessages = {
  backDestination: "Settings",
  currentPassword: {
    label: "Current password",
    required: "Enter your current password.",
    invalid: "The current password is not correct.",
  },
  loginLink: "Log in",
  password: {
    screenName: "Change password",
    notice: "You stay signed in on this device, and sessions of this account on other devices end.",
    newLabel: "New password",
    newHelper: "At least 15 characters. A long phrase works well.",
    confirmationLabel: "Confirm new password",
    submit: "Change password",
    submitting: "Changing…",
    submittingStatus: "Changing",
    uncertain: "We could not confirm the result. If your session ended, log in with the new password; otherwise try again.",
  },
  recoveryCode: {
    screenName: "Regenerate the recovery code",
    notice: "Your current recovery code stops working as soon as the new one is created, and we will not show it again. The new code is shown only once.",
    submit: "Regenerate the code",
    submitting: "Creating…",
    submittingStatus: "Creating",
    uncertain: "We could not confirm the result. Try again; each successful attempt replaces the previous code.",
  },
  deleteAccount: {
    screenName: "Delete account",
    warning: "Deleting the account is immediate and permanent, and it cannot be undone.",
    effectsHeading: "What will be deleted?",
    effects: [
      "Your account, your settings and the record of your consent to the terms.",
      "Your plans, sessions, answers and progress.",
      "Your plan conversation messages with the assistant.",
      "Your recovery code and your sign-ins on every device.",
    ],
    knowHeading: "What you should know",
    know: [
      "Your answers are not stored on this device; everything recorded is kept in your cloud account and will be deleted with it.",
      "We do not keep a downloadable copy of your data, and it cannot be recovered after deletion.",
      "The service provider may keep internal backups for a period set by its plan; see the «privacy statement».",
      "Deleting needs a network connection.",
    ],
    privacyLink: "Privacy statement",
    acknowledgment: "I understand that deleting my account is permanent and cannot be undone",
    acknowledgmentRequired: "Confirm that you understand the deletion is permanent before you continue.",
    submit: "Delete my account permanently",
    submitting: "Deleting…",
    submittingStatus: "Deleting",
    cancel: "Cancel",
    notDeleted: "Your account was not deleted.",
    uncertain: "We could not confirm the result. If the account was deleted your session will end; otherwise try again.",
  },
};

const CATALOGS: Record<Locale, AccountSecurityMessages> = { ar, en };

export function accountSecurityMessages(locale: Locale): AccountSecurityMessages {
  return CATALOGS[locale];
}
