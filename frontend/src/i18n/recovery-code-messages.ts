// Strings of S-04, the recovery-code save (UI-screens Batch 1, section 3). Arabic is verbatim from the S-04 table; English is proposed (UI-tokens A7).
// Owner copy fixes of 4 October 2026: no dash in c4, in the first line of the file, or in the leave and guard-9 sentences, and no ellipsis.

export interface RecoveryCodeMessages {
  step: string; // c1, the recovery host only
  lead: string; // c3
  oldCodeInvalid: string; // c3b, the recovery and settings hosts
  warning: string; // c4
  blockName: string; // c5, name
  blockDescription: string; // c5, description
  copy: string; // c6
  download: string; // c7
  confirmLabel: string; // c8
  confirmRequired: string; // validation at c8
  continueLabel: string; // c9
  copied: string; // toast
  downloaded: string; // toast
  copyUnavailable: string; // notice when the clipboard cannot be written
  fileTitle: string; // line 1 of the downloaded file
  fileWarning: string; // line 3 of the downloaded file
  leave: {
    title: string;
    body: string;
    bodyRecovery: string; // the recovery host: the learner has to log in first
    stay: string; // primary, initial focus
    leave: string; // secondary
  };
  unavailable: string; // guard 9 and a left screen: the Info banner of the next screen
  unavailableRecovery: string; // the same on S-01
}

export const recoveryCodeAr: RecoveryCodeMessages = {
  step: "الخطوة ٣ من ٣",
  lead: "يظهر هذا الرمز مرة واحدة فقط ولن نستطيع عرضه لك مرة أخرى. احفظه في مكان آمن خارج التطبيق.",
  oldCodeInvalid: "الرمز القديم لم يعد صالحًا.",
  warning: "لا يمكن استرجاع الحساب دون الرمز. إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك.",
  blockName: "رمز الاسترجاع",
  blockDescription: "يظهر مرة واحدة فقط",
  copy: "نسخ",
  download: "تنزيل",
  confirmLabel: "حفظت الرمز في مكان آمن خارج التطبيق",
  confirmRequired: "أكّد أنك حفظت الرمز قبل المتابعة.",
  continueLabel: "متابعة",
  copied: "تم النسخ",
  downloaded: "تم تنزيل الملف",
  copyUnavailable: "تعذّر النسخ تلقائيًا. حدّد الرمز وانسخه يدويًا.",
  fileTitle: "قطرة غيث: رمز الاسترجاع",
  fileWarning: "احتفظ بهذا الملف في مكان آمن ولا تشاركه.",
  leave: {
    title: "لم تؤكد حفظ الرمز",
    body: "إن غادرت الآن فلن يظهر هذا الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.",
    bodyRecovery: "إن غادرت الآن فلن يظهر هذا الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات بعد تسجيل الدخول.",
    stay: "البقاء وحفظ الرمز",
    leave: "المغادرة دون حفظ",
  },
  unavailable: "لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.",
  unavailableRecovery: "لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات بعد تسجيل الدخول.",
};

export const recoveryCodeEn: RecoveryCodeMessages = {
  step: "Step 3 of 3",
  lead: "This code is shown only once and we cannot show it to you again. Keep it in a safe place outside the app.",
  oldCodeInvalid: "Your old code no longer works.",
  warning: "The account cannot be recovered without the code. If you lose both your password and this code, we cannot recover your account.",
  blockName: "Recovery code",
  blockDescription: "Shown once only",
  copy: "Copy",
  download: "Download",
  confirmLabel: "I have saved the code in a safe place outside the app",
  confirmRequired: "Confirm that you have saved the code before you continue.",
  continueLabel: "Continue",
  copied: "Copied",
  downloaded: "File downloaded",
  copyUnavailable: "Automatic copy is not available. Select the code and copy it by hand.",
  fileTitle: "Qatra: recovery code",
  fileWarning: "Keep this file somewhere safe and do not share it.",
  leave: {
    title: "You have not confirmed saving the code",
    body: "If you leave now this code will not be shown again. You can create a new one in Settings.",
    bodyRecovery: "If you leave now this code will not be shown again. You can create a new one in Settings after you log in.",
    stay: "Stay and save the code",
    leave: "Leave without saving",
  },
  unavailable: "The code cannot be shown again. You can create a new one in Settings.",
  unavailableRecovery: "The code cannot be shown again. You can create a new one in Settings after you log in.",
};
