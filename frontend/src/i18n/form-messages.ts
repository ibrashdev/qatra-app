// Strings the forms of Batch 1 share (UI-screens P-03 to P-08). Arabic is verbatim from docs/UI-screens.md; English is proposed (UI-tokens A7).

export interface FormMessages {
  errorSummary: (count: string) => string; // P-03; the count arrives already formatted for the language
  dismiss: string; // proposed: no source names the dismiss control of a banner
  showPassword: string; // P-08
  hidePassword: string;
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

export const formAr: FormMessages = {
  errorSummary: (count) => `يوجد ${count} أخطاء في النموذج`,
  dismiss: "إغلاق التنبيه",
  showPassword: "إظهار كلمة المرور",
  hidePassword: "إخفاء كلمة المرور",
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
  errorSummary: (count) => `There are ${count} errors in the form`,
  dismiss: "Dismiss message",
  showPassword: "Show password",
  hidePassword: "Hide password",
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
