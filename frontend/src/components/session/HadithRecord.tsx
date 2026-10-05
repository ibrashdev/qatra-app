"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { sessionMessages } from "@/i18n/session-messages";

// The record that stands beside a hadith (D90): its takhrij and its grade, each as the edition states it, or «غير مذكور في النسخة» when it does not. Shared by
// the learn step of a session and by the lessons reader, so both show a hadith the same way. The label follows the interface language and the value is
// the book's own Arabic.
export function HadithRecord({ takhrij, grade }: { takhrij: string | null; grade: string | null }) {
  const { locale, direction } = useLocale();
  const t = sessionMessages(locale).learn;
  return (
    <div lang={locale} dir={direction} className="flex flex-col gap-q4 text-small text-ink-secondary">
      <p>
        {t.takhrij} <bdi lang="ar">{takhrij ?? t.notStated}</bdi>
      </p>
      <p>
        {t.grade} <bdi lang="ar">{grade ?? t.notStated}</bdi>
      </p>
    </div>
  );
}
