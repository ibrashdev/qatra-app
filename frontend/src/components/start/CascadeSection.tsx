"use client";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ChoiceList, type ChoiceOption } from "@/components/ui/ChoiceList";
import { MultiSelect, type MultiSelectChip, type MultiSelectRow } from "@/components/ui/MultiSelect";
import { OfflineBanner, UnavailableBanner } from "@/components/ui/FormBanners";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { getStartMessages } from "@/i18n/start-messages";
import { useConnectivity } from "@/lib/net/use-connectivity";
import type { CatalogState } from "./use-start-data";
import { groupCountText, groupKindOf, groupLabel } from "./group-label";
import {
  countState,
  groupState,
  listKind,
  localizeDigits,
  MAX_SECTIONS,
  type Cascade,
  type CategoryGroup,
  type StartForm,
  selectedOrdinals,
} from "./start-model";

export interface CascadeHandlers {
  onCategory: (slug: string) => void;
  onBook: (editionId: string) => void;
  onJuz: (number: number) => void;
  onToggleRow: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onRemoveChip: (id: string) => void;
  onRetry: () => void;
}

// Levels 1 to 3 of the cascade (D78, D88, UI-tokens 6.26): a run of labelled groups, each shown only once the one above is chosen, in the page flow.
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

  const juzOptions: ChoiceOption[] = cascade.juzList.map((option) => ({ value: String(option.number), title: t.juz.title(formatted(option.number)), lang: locale }));

  const kind = listKind(cascade);
  const selectedSet = new Set(selected);
  const sectionRow = (section: (typeof cascade.sections)[number]): MultiSelectRow => ({
    id: String(section.ordinal),
    title: titleOf(section),
    reference: localizeDigits(section.reference, locale),
    state: selectedSet.has(section.ordinal) ? "checked" : "unchecked",
    locked: atLimit,
    lang: locale,
  });
  const grouped = cascade.groups.length > 0;
  const groupKind = groupKindOf(cascade);
  let rows: MultiSelectRow[] = [];
  let chips: MultiSelectChip[] = [];
  if (grouped) {
    // D88: a long book lists group rows; each opens onto its own sections. A fully checked group is one chip, and the checked sections of a
    // partly checked group are chips one by one.
    for (const group of cascade.groups) {
      const state = groupState(selected, group.sections);
      const label = groupLabel(locale, groupKind, group);
      rows.push({
        id: group.id,
        title: label,
        note: groupCountText(locale, groupKind, group),
        state,
        locked: atLimit,
        lang: locale,
        disclosure: { label: t.list.customize, name: t.list.customizeName(label), childRows: group.sections.map(sectionRow) },
      });
      if (state === "checked") chips.push({ id: group.id, title: label, lang: locale });
      else if (state === "mixed") chips.push(...group.sections.filter((section) => selectedSet.has(section.ordinal)).map((section) => ({ id: String(section.ordinal), title: titleOf(section), lang: locale })));
    }
  } else if (cascade.mode !== null) {
    rows = cascade.sections.map(sectionRow);
    chips = rows.filter((row) => row.state === "checked").map((row) => ({ id: row.id, title: row.title, lang: locale }));
  }

  return (
    <div className="flex flex-col gap-q16">
      <ChoiceList legend={t.category.legend} options={categoryOptions} value={cascade.category?.slug ?? null} onChange={handlers.onCategory} />

      {cascade.showBooks ? <ChoiceList legend={t.books.legend} options={bookOptions} value={cascade.edition?.editionId ?? null} onChange={handlers.onBook} /> : null}

      {cascade.showJuz ? (
        <ChoiceList legend={t.juz.legend} options={juzOptions} value={cascade.juz ? String(cascade.juz.number) : null} onChange={(value) => handlers.onJuz(Number(value))} />
      ) : null}

      {kind !== null ? (
        <MultiSelect
          // A new book or juz' starts with every group collapsed.
          key={`${cascade.edition?.editionId ?? ""}:${cascade.juz?.number ?? ""}`}
          legend={t.list.legends[kind]}
          countText={countText}
          rows={rows}
          chips={chips}
          selectAll={{ label: t.tools.selectAll, inert: count.kind === "all", hidden: sectionsTotal > MAX_SECTIONS }}
          clear={{ label: t.tools.clear, inert: count.kind === "none" }}
          chipsLabel={t.chips.group}
          chipsHidden={count.kind === "all"}
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
