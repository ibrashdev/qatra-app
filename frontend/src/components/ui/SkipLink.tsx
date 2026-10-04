"use client";

import { useLocale } from "@/i18n/LocaleProvider";

// First focusable element of every shell; visible only while focused. The target is <main id="main">.
export function SkipLink() {
  const { messages } = useLocale();
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:start-q16 focus:top-q16 focus:z-(--q-z-skip) focus:min-h-target focus:rounded-sm focus:bg-inverse focus:px-q16 focus:py-q12 focus:text-button focus:text-on-primary"
    >
      {messages.skipToContent}
    </a>
  );
}
