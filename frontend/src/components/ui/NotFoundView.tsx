"use client";

import Link from "next/link";
import { useLocale } from "@/i18n/LocaleProvider";
import { PageTitle } from "./PageTitle";

export function NotFoundView() {
  const { messages } = useLocale();
  return (
    <>
      <PageTitle screenName={messages.notFound.title} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {messages.notFound.title}
      </h1>
      <p className="mt-q16 text-body text-ink-secondary">{messages.notFound.body}</p>
      <Link
        href="/"
        className="mt-q24 inline-flex min-h-button items-center rounded-sm border border-edge bg-surface px-q24 text-button text-primary-deep transition-[color,background-color,border-color] duration-(--q-duration-fast) hover:bg-selection active:border-primary-deep"
      >
        {messages.notFound.action}
      </Link>
    </>
  );
}
