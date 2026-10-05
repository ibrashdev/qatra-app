// S-06 (re-consent gate) strings. Arabic is verbatim from docs/UI-screens.md S-06 and the patterns it cites; English is proposed (UI-tokens A7).
// The screen name (the H1 and the document title) is `screens.consent` of messages.ts; the shared form lines (P-04 to P-07) come from form-messages.ts.
import type { Locale } from "./messages";

export interface ConsentMessages {
  lead: string; // c2
  // c3: {version} and {username} are filled with nodes, so each can sit in its own isolated run.
  versionAndAccount: string;
  accountOnly: string; // the same line when the build knows no terms version (the line never states a version it does not have)
  termsLink: string; // c4
  consentLabel: string; // c5
  termsOfUse: string; // c6
  privacyStatement: string;
  submit: string; // c7
  submitting: string;
  submittingStatus: string; // the polite announcement while E05 is in flight
  logout: string; // c8
  loggingOut: string;
  loggingOutStatus: string; // the polite announcement while E10 is in flight
  consentRequired: string; // G-18, the error at the box
  logoutFailed: string; // E10 without an answer, or 403, 5xx
}

const ar: ConsentMessages = {
  lead: "تغيّرت شروط الاستخدام وبيان الخصوصية. اقرأها ثم أكّد موافقتك للمتابعة.",
  versionAndAccount: "إصدار الشروط: {version}؛ أنت مسجّل باسم {username}",
  accountOnly: "أنت مسجّل باسم {username}",
  termsLink: "شروط الاستخدام وبيان الخصوصية",
  consentLabel: "قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها",
  termsOfUse: "شروط الاستخدام",
  privacyStatement: "بيان الخصوصية",
  submit: "متابعة",
  submitting: "جارٍ الحفظ…",
  submittingStatus: "جارٍ الحفظ",
  logout: "تسجيل الخروج",
  loggingOut: "جارٍ الخروج…",
  loggingOutStatus: "جارٍ الخروج",
  consentRequired: "يلزم تأكيد موافقتك على شروط الاستخدام وبيان الخصوصية للمتابعة.",
  logoutFailed: "تعذّر تسجيل الخروج. حاول مرة أخرى.",
};

const en: ConsentMessages = {
  lead: "The terms of use and privacy statement have changed. Read them, then confirm your agreement to continue.",
  versionAndAccount: "Terms version: {version}; You are signed in as {username}",
  accountOnly: "You are signed in as {username}",
  termsLink: "Terms of use and privacy statement",
  consentLabel: "I have read the terms of use and privacy statement and I agree to them.",
  termsOfUse: "Terms of use",
  privacyStatement: "Privacy statement",
  submit: "Continue",
  submitting: "Saving…",
  submittingStatus: "Saving",
  logout: "Log out",
  loggingOut: "Logging out…",
  loggingOutStatus: "Logging out",
  consentRequired: "You must confirm your agreement to the terms of use and privacy statement to continue.",
  logoutFailed: "Logging out failed. Try again.",
};

const CATALOGS: Record<Locale, ConsentMessages> = { ar, en };

export function consentMessages(locale: Locale): ConsentMessages {
  return CATALOGS[locale];
}
