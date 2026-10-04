"use client";

import { createContext, use, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { applyLocaleToDocument } from "./locale";
import { getLocaleSnapshot, getServerLocaleSnapshot, setLocale, subscribeLocale } from "./locale-store";
import { directionForLocale, getMessages, type Direction, type Locale, type UiMessages } from "./messages";

export interface LocaleContextValue {
  locale: Locale;
  direction: Direction;
  messages: UiMessages;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getServerLocaleSnapshot);

  // React resets the <html> attributes it manages on a development remount, so the stored preference is applied again here.
  useLayoutEffect(() => {
    applyLocaleToDocument(getLocaleSnapshot());
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, direction: directionForLocale(locale), messages: getMessages(locale), setLocale }),
    [locale],
  );

  return <LocaleContext value={value}>{children}</LocaleContext>;
}

export function useLocale(): LocaleContextValue {
  const value = use(LocaleContext);
  if (value === null) throw new Error("useLocale must be used inside LocaleProvider.");
  return value;
}
