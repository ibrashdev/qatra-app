"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { PageTitle } from "./PageTitle";

// Standalone on purpose: if a shell threw, the error view must not depend on that shell.
export function ErrorView({ retry }: { retry: () => void }) {
  const { messages } = useLocale();
  return (
    <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column px-page py-q32">
      <PageTitle screenName={messages.error.title} />
      <div role="alert">
        <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
          {messages.error.title}
        </h1>
      </div>
      <button
        type="button"
        onClick={retry}
        className="mt-q24 inline-flex min-h-button min-w-22 items-center justify-center rounded-sm border border-edge bg-surface px-q24 text-button text-primary-deep transition-[color,background-color,border-color] duration-(--q-duration-fast) hover:bg-selection active:border-primary-deep"
      >
        {messages.error.retry}
      </button>
    </main>
  );
}
