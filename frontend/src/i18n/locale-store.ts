import { LOCALE_STORAGE_KEY, applyLocaleToDocument, resolveInitialLocale, writeStoredLocale } from "./locale";
import { DEFAULT_LOCALE, type Locale } from "./messages";

let current: Locale | null = null;
let storageListenerAttached = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

// The server always renders the default; the client value is read lazily after hydration.
export function getLocaleSnapshot(): Locale {
  if (current === null) current = resolveInitialLocale();
  return current;
}

export function getServerLocaleSnapshot(): Locale {
  return DEFAULT_LOCALE;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== LOCALE_STORAGE_KEY) return;
  current = null;
  applyLocaleToDocument(getLocaleSnapshot());
  emit();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListenerAttached) {
    window.addEventListener("storage", onStorage);
    storageListenerAttached = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageListenerAttached) {
      window.removeEventListener("storage", onStorage);
      storageListenerAttached = false;
    }
  };
}

export function setLocale(next: Locale): void {
  current = next;
  writeStoredLocale(next);
  applyLocaleToDocument(next);
  emit();
}

export function resetLocaleStoreForTests(): void {
  current = null;
}
