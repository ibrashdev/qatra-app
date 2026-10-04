import { DEFAULT_LOCALE, directionForLocale, isLocale, type Locale } from "./messages";

export const LOCALE_STORAGE_KEY = "qatra.language";

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// Storage can be missing or throw (private window, blocked site data), so every access is wrapped (UA-17).
export function readStoredLocale(storage: Pick<Storage, "getItem"> | null = browserStorage()): Locale | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: Locale, storage: Pick<Storage, "setItem"> | null = browserStorage()): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The choice then lasts for this visit only.
  }
}

// The first browser language that is Arabic or English wins; anything else falls back to Arabic (UA-11).
export function detectBrowserLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "ar" || primary === "en") return primary;
  }
  return DEFAULT_LOCALE;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

export function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? detectBrowserLocale(browserLanguages());
}

export function applyLocaleToDocument(locale: Locale, root: HTMLElement = document.documentElement): void {
  root.lang = locale;
  root.dir = directionForLocale(locale);
}

// Inline script for <head>: sets lang and dir before first paint, so there is no flash in the wrong direction.
// It repeats resolveInitialLocale; tests/unit/locale.test.ts runs both against the same cases.
export const LOCALE_BOOT_SCRIPT =
  `(function(){try{var l=null;try{l=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)})}catch(e){}` +
  `if(l!=="ar"&&l!=="en"){l="ar";var a=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];` +
  `for(var i=0;i<a.length;i++){var p=String(a[i]||"").toLowerCase().split("-")[0];if(p==="ar"||p==="en"){l=p;break}}}` +
  `var d=document.documentElement;d.lang=l;d.dir=l==="ar"?"rtl":"ltr"}catch(e){}})()`;
