// S-26 (privacy and data) strings. Arabic is verbatim from docs/UI-screens.md S-26 (section 3 table); English is proposed (UI-tokens A7).
// The H1 and the page title are the name of S-03 (`messages.screens.terms`, O-50), the back control name is built from the Settings tab name,
// and the text itself comes from terms-text.ts and loads with this route.
import type { Locale } from "./messages";

export interface PrivacyMessages {
  returnButton: string; // c4
}

const ar: PrivacyMessages = { returnButton: "العودة إلى الإعدادات" };
const en: PrivacyMessages = { returnButton: "Back to Settings" };

export const privacyAr = ar;
export const privacyEn = en;

const CATALOGS: Record<Locale, PrivacyMessages> = { ar, en };

export function privacyMessages(locale: Locale): PrivacyMessages {
  return CATALOGS[locale];
}
