"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { sourcesMessages } from "@/i18n/sources-messages";
import { renderTemplate } from "@/i18n/template";
import type { CatalogEdition } from "@/lib/api/types";
import { categoryLabel, editionTitle } from "@/lib/catalog/catalog-model";

// S-25 c3 to c7: one card per edition (UI-tokens 6.7), the title as the H2. Nothing here comes from the book itself: the reference line follows from the
// edition's content format, and the takhrij note is fixed text for a hadith edition (E14 has no publisher or reference field, UG-05, O-48).
export function SourceCard({ edition }: { edition: CatalogEdition }) {
  const { locale } = useLocale();
  const t = sourcesMessages(locale);
  return (
    <li className="rounded-md border border-divider bg-surface p-q16">
      <h2 className="text-body font-semibold text-ink">
        <bdi dir="auto">{editionTitle(locale, edition)}</bdi>
      </h2>
      <p className="mt-q4 text-small text-ink-secondary">
        <bdi dir="auto">{edition.author}</bdi>
        {" · "}
        <bdi dir="auto">{edition.editionLabel}</bdi>
      </p>
      <p className="mt-q8 text-body-compact text-ink">{renderTemplate(t.category, { label: <bdi dir="auto">{categoryLabel(locale, edition.category)}</bdi> })}</p>
      <p className="mt-q4 text-body-compact text-ink">{t.reference[edition.contentFormat]}</p>
      {edition.contentFormat === "hadith_collection" ? <p className="mt-q8 text-small text-ink-secondary">{t.takhrij}</p> : null}
    </li>
  );
}
