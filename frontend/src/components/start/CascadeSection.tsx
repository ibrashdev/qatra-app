"use client";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ChoiceList, type ChoiceOption } from "@/components/ui/ChoiceList";
import { MultiSelect, type MultiSelectRow } from "@/components/ui/MultiSelect";
import { OfflineBanner, UnavailableBanner } from "@/components/ui/FormBanners";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { getStartMessages } from "@/i18n/start-messages";
import { useConnectivity } from "@/lib/net/use-connectivity";
import type { CatalogState } from "./use-start-data";
import {
  countState,
  juzState,
  listKind,
  localizeDigits,
  MAX_SECTIONS,
  JUZ_AMMA_NUMBER,
  type Cascade,
  type CategoryGroup,
  type SelectionView,
  type StartForm,
  selectedOrdinals,
} from "./start-model";

export interface CascadeHandlers {
  onCategory: (slug: string) => void;
  onBook: (editionId: string) => void;
  onView: (view: SelectionView) => void;
  onToggleRow: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onRemoveChip: (id: string) => void;
  onRetry: () => void;
}

// Levels 1 to 3 of the cascade (D78, UI-tokens 6.26): a run of labelled groups, each shown only once the one above is chosen, in the page flow.
export function CascadeSection({
  catalog,
  groups,
  form,
  cascade,
  handlers,
}: {
  catalog: CatalogState;
  groups: readonly CategoryGroup[];
  form: StartForm;
  cascade: Cascade;
  handlers: CascadeHandlers;
}) {
  const { locale } = useLocale();
  const { online } = useConnectivity();
  const t = getStartMessages(locale);
  const titleOf = (entry: { titleAr: string; titleEn: string }) => (locale === "ar" ? entry.titleAr : entry.titleEn);

  if (catalog.status === "loading") {
    return <ChoiceList legend={t.category.legend} options={[]} value={null} onChange={handlers.onCategory} loading />;
  }

  // No stale list is kept (P-07): the failure and the retry take the place of the levels.
  if (catalog.status === "error") {
    return (
      <div className="flex flex-col gap-q16">
        {catalog.kind === "connectivity" ? (
          online ? (
            <UnavailableBanner />
          ) : (
            <OfflineBanner />
          )
        ) : catalog.kind === "unavailable" ? (
          <UnavailableBanner />
        ) : (
          <InternalAlert />
        )}
        <div>
          <RetryButton onRetry={handlers.onRetry} />
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return <Banner variant="info">{t.noMaterial}</Banner>;
  }

  const categoryOptions: ChoiceOption[] = groups.map((group) => ({ value: group.slug, title: locale === "ar" ? group.labelAr : group.labelEn, lang: locale }));
  const bookOptions: ChoiceOption[] = (cascade.category?.editions ?? []).map((edition) => ({
    value: edition.editionId,
    title: titleOf(edition),
    detail: t.books.detail(edition.author, edition.editionLabel),
    lang: locale,
  }));

  const sectionsTotal = cascade.sections.length;
  const selected = selectedOrdinals(form, cascade);
  const formatted = (value: number) => formatInteger(locale, value);
  const count = countState(selected.length, sectionsTotal);
  const countText = count.kind === "none" ? t.count.none : count.kind === "all" ? t.count.all(formatted(count.m)) : t.count.some(formatted(count.n), formatted(count.m));
  const atLimit = sectionsTotal > MAX_SECTIONS && selected.length >= MAX_SECTIONS;

  const kind = listKind(cascade);
  const selectedSet = new Set(selected);
  let rows: MultiSelectRow[] = [];
  if (cascade.mode === "juz") {
    rows = [
      {
        id: "juz",
        title: t.list.juzTitle(formatted(JUZ_AMMA_NUMBER)),
        note: t.list.juzNote(formatted(sectionsTotal)),
        state: juzState(selected, cascade.sections),
        locked: false,
        lang: locale,
      },
    ];
  } else if (cascade.mode !== null) {
    rows = cascade.sections.map((section) => ({
      id: String(section.ordinal),
      title: titleOf(section),
      reference: localizeDigits(section.reference, locale),
      state: selectedSet.has(section.ordinal) ? "checked" : "unchecked",
      locked: atLimit,
      lang: locale,
    }));
  }

  return (
    <div className="flex flex-col gap-q16">
      <ChoiceList legend={t.category.legend} options={categoryOptions} value={cascade.category?.slug ?? null} onChange={handlers.onCategory} />

      {cascade.showBooks ? <ChoiceList legend={t.books.legend} options={bookOptions} value={cascade.edition?.editionId ?? null} onChange={handlers.onBook} /> : null}

      {cascade.showView ? (
        <SegmentedControl
          legend={t.view.legend}
          segmentWidth="wide"
          value={cascade.view}
          onChange={handlers.onView}
          options={[
            { value: "surah", label: t.view.surah },
            { value: "juz", label: t.view.juz },
          ]}
        />
      ) : null}

      {kind !== null ? (
        <MultiSelect
          legend={t.list.legends[kind]}
          countText={countText}
          rows={rows}
          selectAll={{ label: t.tools.selectAll, inert: count.kind === "all", hidden: sectionsTotal > MAX_SECTIONS }}
          clear={{ label: t.tools.clear, inert: count.kind === "none" }}
          chipsLabel={t.chips.group}
          chipsHidden={count.kind === "all" && cascade.mode !== "juz"}
          removeLabel={t.chips.remove}
          limitHelper={atLimit ? t.limit : null}
          onToggleRow={handlers.onToggleRow}
          onSelectAll={handlers.onSelectAll}
          onClear={handlers.onClear}
          onRemoveChip={handlers.onRemoveChip}
        />
      ) : null}
    </div>
  );
}

function InternalAlert() {
  const { messages } = useLocale();
  return (
    <Banner variant="error" role="alert">
      {messages.form.internal}
    </Banner>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const { messages } = useLocale();
  return (
    <Button variant="secondary" onClick={onRetry}>
      {messages.server.retry}
    </Button>
  );
}
