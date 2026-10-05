// Strings of the interim placement route (S-09's approved skip path, UG-12). Arabic is verbatim from docs/UI-screens.md S-09 where it fixes the
// words; the rest is proposed copy (UI-tokens A7). S-09's own screen replaces this catalog.
import type { Locale } from "./messages";

export interface PlacementMessages {
  title: string; // H1
  backDestination: string;
  notAvailable: string;
  continue: string;
  preparing: string; // «جارٍ تجهيز المحادثة…»
  editionUnavailable: string; // G-20
  conversationFailed: string; // E31 422 on the plan options
  editOptions: string;
}

export const placementAr: PlacementMessages = {
  title: "اختبار قصير",
  backDestination: "ما هي خطتك؟",
  notAvailable: "الاختبار القصير غير متاح الآن. يمكنك المتابعة إلى الخطة مباشرة.",
  continue: "متابعة إلى الخطة",
  preparing: "جارٍ تجهيز المحادثة…",
  editionUnavailable: "هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.",
  conversationFailed: "تعذّر بدء المحادثة بسبب خيارات الخطة. عدّلها ثم أعد المحاولة.",
  editOptions: "تعديل الخيارات",
};

export const placementEn: PlacementMessages = {
  title: "Short test",
  backDestination: "What is your plan?",
  notAvailable: "The short test is not available yet. You can continue straight to the plan.",
  continue: "Continue to the plan",
  preparing: "Preparing the conversation…",
  editionUnavailable: "This edition is no longer available. You can start a plan on another edition.",
  conversationFailed: "The conversation could not start because of the plan options. Change them and try again.",
  editOptions: "Change the options",
};

export function placementMessages(locale: Locale): PlacementMessages {
  return locale === "ar" ? placementAr : placementEn;
}
