"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { catalogMessages } from "@/i18n/catalog-messages";
import { formatInteger } from "@/i18n/format";
import type { CatalogSection } from "@/lib/api/types";
import { sectionTitle } from "@/lib/catalog/catalog-model";

// UI-tokens 6.25: a native disclosure whose summary is the list row (at least 56 px, the count in the name, the chevron at the end edge, vertical and not
// mirrored). The sections start collapsed and the open state is not remembered. The rows are text: no link, no control, never a verse or a hadith (S-07).
// It sits edge to edge in the card, so its rows reach the card's border and the card's padding does not narrow them.
export function SectionDisclosure({ sections }: { sections: readonly CatalogSection[] }) {
  const { locale } = useLocale();
  const t = catalogMessages(locale);
  const count = (value: number) => ({ count: value, formatted: formatInteger(locale, value) });

  return (
    <details className="group -mx-q16 -mb-q16 mt-q16 border-t border-divider">
      <summary className="flex min-h-row cursor-pointer list-none items-center justify-between gap-q12 px-q16 text-body text-ink hover:bg-selection active:bg-selection active:text-primary-deep focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden">
        <span>{t.sectionsToggle(formatInteger(locale, sections.length))}</span>
        <span aria-hidden="true" className="size-q8 shrink-0 rotate-45 border-b-2 border-e-2 border-ink-secondary rtl:-scale-x-100 group-open:rotate-[225deg]" />
      </summary>
      <ul className="border-t border-divider">
        {sections.map((section) => (
          <li key={section.sectionId} className="flex min-h-row flex-col justify-center border-b border-divider px-q16 py-q8 last:border-b-0">
            {/* The English title already carries the number ("Surah 78"), so only the Arabic title is followed by its reference (UA-05). */}
            <p className="text-body-compact text-ink">
              <bdi dir="auto">{sectionTitle(locale, section)}</bdi>
              {locale === "ar" ? (
                <>
                  {" · "}
                  <bdi dir="ltr">{section.reference}</bdi>
                </>
              ) : null}
            </p>
            <p className="text-small text-ink-secondary">{t.rowCounts(count(section.wordCount), count(section.passageCount))}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
