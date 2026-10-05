"use client";

import { Fragment, type ReactNode } from "react";
import { Notice } from "@/components/ui/Notice";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import type { SourceRef } from "@/lib/api/types";
import { Icon } from "@/components/ui/Icon";

// A link is made only for a web address; anything else is shown as plain text, so a value that is not http(s) can never become a script link.
function isWebUrl(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

// UI-screens P-20: book, edition, reference, then the printed page or the canonical URL, parts joined by « · » in bdi. No publisher name, ruling,
// takhrij or grade appears in a question. The D50 notice follows only when the screen says the edition gives neither attribution nor grade.
export function QuestionSource({ source, showD50Notice = false }: { source: SourceRef; showD50Notice?: boolean }) {
  const { locale } = useLocale();
  const messages = questionMessages(locale);

  const parts: ReactNode[] = [
    <bdi key="book" lang="ar">
      {source.bookTitleAr}
    </bdi>,
    <bdi key="edition">{source.editionLabel}</bdi>,
    <bdi key="reference" lang="ar">
      {source.reference}
    </bdi>,
  ];
  if (source.pages.length > 0) {
    parts.push(
      <bdi key="pages">{messages.source.page(source.pages.join(locale === "ar" ? "، " : ", "))}</bdi>,
    );
  }
  if (source.url !== "") {
    parts.push(
      isWebUrl(source.url) ? (
        <a
          key="url"
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={messages.source.opensInNewTab(source.reference)}
          className="inline-flex min-h-target items-center gap-q4 text-link underline [overflow-wrap:anywhere]"
        >
          <bdi dir="ltr">{source.url}</bdi>
          <Icon name="external" size="sm" />
        </a>
      ) : (
        <bdi key="url" dir="ltr" className="[overflow-wrap:anywhere]">
          {source.url}
        </bdi>
      ),
    );
  }

  return (
    <div className="flex flex-col gap-q8">
      <p className="text-small text-ink-secondary">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? " · " : null}
            {part}
          </Fragment>
        ))}
      </p>
      {showD50Notice ? <Notice>{messages.d50Notice}</Notice> : null}
    </div>
  );
}
