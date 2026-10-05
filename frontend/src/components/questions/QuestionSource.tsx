"use client";

import { Fragment, type ReactNode } from "react";
import { Notice } from "@/components/ui/Notice";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import type { SourceRef } from "@/lib/api/types";
import { Icon } from "@/components/ui/Icon";

// A link is made only for a web address; anything else is not a link at all, so a value that is not http(s) can never become a script link.
function isWebUrl(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

// D90 (owner approvals of 5 October 2026): the book and its human reference, then the printed page when the edition has one, then a link labelled
// «المصدر» that opens the canonical page in a new tab. The edition label, the provider name and the technical reference code are never shown, and no
// ruling, takhrij or grade appears in a question. The D50 notice follows only when the screen says the edition gives neither attribution nor grade.
// A question shows this line only after it is answered; the learn step shows it with the passage.
export function QuestionSource({ source, showD50Notice = false }: { source: SourceRef; showD50Notice?: boolean }) {
  const { locale } = useLocale();
  const messages = questionMessages(locale);
  const referenceAr = source.referenceAr ?? "";

  const parts: ReactNode[] = [
    <bdi key="book" lang="ar">
      {source.bookTitleAr}
    </bdi>,
  ];
  if (referenceAr !== "") {
    parts.push(
      <bdi key="reference" lang="ar">
        {referenceAr}
      </bdi>,
    );
  }
  if (source.pages.length > 0) {
    parts.push(
      <bdi key="pages">{messages.source.page(source.pages.join(locale === "ar" ? "، " : ", "))}</bdi>,
    );
  }
  if (isWebUrl(source.url)) {
    parts.push(
      <a
        key="url"
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={messages.source.opensInNewTab(referenceAr === "" ? source.bookTitleAr : referenceAr)}
        className="inline-flex min-h-target items-center gap-q4 text-link underline"
      >
        {messages.source.link}
        <Icon name="external" size="sm" />
      </a>,
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
