"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { catalogMessages } from "@/i18n/catalog-messages";
import { formatInteger } from "@/i18n/format";
import type { CatalogEdition } from "@/lib/api/types";
import { editionTitle } from "@/lib/catalog/catalog-model";
import { SectionDisclosure } from "./SectionDisclosure";

// S-07 c7 to c11: one card per edition (UI-tokens 6.7: surface fill, 1 px divider, radius md, 16 px padding, no shadow, no whole-card link).
// The card overflows hidden so the disclosure row's hover fill follows the rounded corners.
export function EditionCard({ edition }: { edition: CatalogEdition }) {
  const { locale } = useLocale();
  const t = catalogMessages(locale);
  const count = (value: number) => ({ count: value, formatted: formatInteger(locale, value) });
  const paths = edition.availablePaths.map((path) => t.pathLabels[path]).join(t.listSeparator);

  return (
    <li className="overflow-hidden rounded-md border border-divider bg-surface p-q16">
      <h3 className="text-body font-semibold text-ink">
        <bdi dir="auto">{editionTitle(locale, edition)}</bdi>
      </h3>
      <p className="mt-q4 text-small text-ink-secondary">
        <bdi dir="auto">{edition.author}</bdi>
        {" · "}
        <bdi dir="auto">{edition.editionLabel}</bdi>
      </p>
      <p className="mt-q8 text-body-compact text-ink">{t.facts(count(edition.sections.length), count(edition.totalWords))}</p>
      <p className="mt-q4 text-body-compact text-ink">{t.pathsLine(paths)}</p>
      <SectionDisclosure sections={edition.sections} />
    </li>
  );
}
