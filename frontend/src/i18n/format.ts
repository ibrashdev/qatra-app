import type { Locale } from "./messages";

// UI-tokens 3.4: Arabic-Indic digits in the Arabic interface, Western digits in the English one.
// The digit system is requested explicitly, because a bare ar-AE locale does not guarantee it.
const DIGIT_LOCALES: Record<Locale, string> = { ar: "ar-u-nu-arab", en: "en-u-nu-latn" };

export function formatInteger(locale: Locale, value: number): string {
  return new Intl.NumberFormat(DIGIT_LOCALES[locale], { useGrouping: false, maximumFractionDigits: 0 }).format(value);
}

// mm:ss for a countdown. The caller wraps it in <bdi dir="ltr">, so the order of the digits never flips.
export function formatClock(locale: Locale, totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const twoDigits = new Intl.NumberFormat(DIGIT_LOCALES[locale], { useGrouping: false, minimumIntegerDigits: 2 });
  return `${twoDigits.format(Math.floor(seconds / 60))}:${twoDigits.format(seconds % 60)}`;
}
