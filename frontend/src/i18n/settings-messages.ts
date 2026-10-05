// S-22 (settings) strings. Arabic is verbatim from docs/UI-screens.md S-22 (section 3 table and section 4 states); English is proposed (UI-tokens A7).
// The failure lines of E11 come from today-messages.ts, the generic service lines from form-messages.ts, the transparency line (c18) from
// plan-chat-messages.ts, the minute labels from start-messages.ts, and the note about a code that cannot be shown again from recovery-code-messages.ts.
import type { Locale } from "./messages";

export interface SettingsMessages {
  screenName: string; // c1, the H1 and the document title
  account: {
    heading: string; // c2
    nameLabel: string; // c3
    syncLabel: string; // c4
    synced: string; // c4, the chip
    password: string; // c5
    recoveryCode: string; // c6
    deleteAccount: string; // c7
  };
  preferences: {
    heading: string; // c8
    language: { legend: string; arabic: string; english: string }; // c9
    minutes: { legend: string; helper: string }; // c10
    reviseLink: string; // c11
    timeZone: { label: string; fromBrowser: string }; // c12
    pending: string; // c13, has {value} and {date}
    reminder: { label: string; helper: string }; // c14
    save: string; // c15
    saving: string;
    nothingToSave: string;
    saved: string; // c20, the toast
    saveFailed: string; // E12 `internal` or no answer
  };
  privacy: { heading: string; privacyRow: string; sourcesRow: string }; // c16, c17
  logout: { button: string; loggingOut: string; failed: string }; // c19
  arrival: { passwordChanged: string; codeRotated: string };
}

const ar: SettingsMessages = {
  screenName: "الإعدادات",
  account: {
    heading: "الحساب",
    nameLabel: "اسم الحساب:",
    syncLabel: "حالة المزامنة:",
    synced: "متزامن",
    password: "تغيير كلمة المرور",
    recoveryCode: "إعادة توليد الرمز",
    deleteAccount: "حذف الحساب",
  },
  preferences: {
    heading: "التفضيلات",
    language: { legend: "اللغة", arabic: "العربية", english: "English" },
    minutes: {
      legend: "الوقت اليومي للخطط الجديدة",
      helper: "يُقترح هذا الوقت عند إنشاء خطة جديدة. لتغيير وقت خطتك الحالية استخدم «تعديل الوقت والهدف».",
    },
    reviseLink: "تعديل الوقت والهدف",
    timeZone: { label: "المنطقة الزمنية", fromBrowser: "من المتصفح" },
    pending: "السارية الآن: {value}. يبدأ هذا التغيير من يوم التعلم التالي ({date}).",
    reminder: {
      label: "تذكير داخل التطبيق",
      helper: "عند فتح التطبيق يظهر إشعار إن كانت لديك مراجعة مستحقة. لا توجد إشعارات خارج التطبيق.",
    },
    save: "حفظ التغييرات",
    saving: "جارٍ الحفظ…",
    nothingToSave: "لا توجد تغييرات للحفظ.",
    saved: "تم حفظ الإعدادات",
    saveFailed: "تعذّر حفظ الإعدادات. حاول مرة أخرى.",
  },
  privacy: { heading: "الخصوصية والمصادر", privacyRow: "الخصوصية والبيانات", sourcesRow: "المصادر" },
  logout: { button: "تسجيل الخروج", loggingOut: "جارٍ الخروج…", failed: "تعذّر تسجيل الخروج. حاول مرة أخرى." },
  arrival: {
    passwordChanged: "تم تغيير كلمة المرور. تنتهي جلسات هذا الحساب على الأجهزة الأخرى، وتبقى هذه الجلسة مفتوحة.",
    codeRotated: "تم إنشاء رمز استرجاع جديد، ولم يعد الرمز القديم صالحًا.",
  },
};

const en: SettingsMessages = {
  screenName: "Settings",
  account: {
    heading: "Account",
    nameLabel: "Account name:",
    syncLabel: "Sync status:",
    synced: "Synced",
    password: "Change password",
    recoveryCode: "Regenerate the recovery code",
    deleteAccount: "Delete account",
  },
  preferences: {
    heading: "Preferences",
    language: { legend: "Language", arabic: "العربية", english: "English" },
    minutes: {
      legend: "Daily time for new plans",
      helper: "This time is suggested when you create a new plan. To change the time of your current plan, use «Adjust time and goal».",
    },
    reviseLink: "Adjust time and goal",
    timeZone: { label: "Time zone", fromBrowser: "From the browser" },
    pending: "In force now: {value}. This change starts on the next learning day ({date}).",
    reminder: {
      label: "In-app reminder",
      helper: "When you open the app, a notice appears if a review is due. There are no notifications outside the app.",
    },
    save: "Save changes",
    saving: "Saving…",
    nothingToSave: "There are no changes to save.",
    saved: "Settings saved",
    saveFailed: "The settings could not be saved. Try again.",
  },
  privacy: { heading: "Privacy and sources", privacyRow: "Privacy and data", sourcesRow: "Sources" },
  logout: { button: "Log out", loggingOut: "Logging out…", failed: "Logging out failed. Try again." },
  arrival: {
    passwordChanged: "Your password was changed. Sessions of this account on other devices have ended, and this one stays open.",
    codeRotated: "A new recovery code was created, and the old code no longer works.",
  },
};

export const settingsAr = ar;
export const settingsEn = en;

const CATALOGS: Record<Locale, SettingsMessages> = { ar, en };

export function settingsMessages(locale: Locale): SettingsMessages {
  return CATALOGS[locale];
}
