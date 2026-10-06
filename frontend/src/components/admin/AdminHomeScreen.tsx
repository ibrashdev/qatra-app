"use client";

import Link from "next/link";
import { useId } from "react";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { RowList } from "@/components/settings/SettingsRows";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { formatInteger } from "@/i18n/format";
import { getOverview } from "@/lib/api/admin-endpoints";
import { EDITION_STATUSES, type AiStatus, type EditionSummary, type Overview } from "@/lib/api/admin-types";
import { bookTitle, formatCount, statusLabel } from "./admin-model";
import { AdminFrame } from "./AdminFrame";
import { InfoList, InfoRow, Mixed, Technical } from "./InfoList";
import { HiddenMark, StatusChip } from "./StatusChip";
import { useAdminResource } from "./use-admin-resource";

// AD-01 Content management (docs/Content-admin.md section 6): the note that only display data is edited here, the counts with links to books,
// categories and sources, the read-only AI card, and the editions, each linking to AD-02. The overview is one read; a retry is always safe.
export function AdminHomeScreen() {
  const { locale, messages } = useLocale();
  const t = adminMessages(locale);
  const resource = useAdminResource("overview", (client, signal) => getOverview(client, { signal }));
  return (
    <AdminFrame title={t.screenName} back={{ destination: messages.tabs.settings, href: "/settings" }} next="/admin" resource={resource}>
      {(overview) => <OverviewContent overview={overview} />}
    </AdminFrame>
  );
}

function OverviewContent({ overview }: { overview: Overview }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const manageId = useId();
  const statusId = useId();
  const editionsId = useId();
  const { counts } = overview;

  const rows = [
    { href: "/admin/books", label: t.home.rows.books, count: counts.books },
    { href: "/admin/categories", label: t.home.rows.categories, count: counts.categories },
    { href: "/admin/sources", label: t.home.rows.sources, count: counts.sources },
  ];

  return (
    <div className="mt-q24 flex flex-col gap-q24">
      <Notice>{t.displayOnlyNote}</Notice>

      <section aria-labelledby={manageId}>
        <h2 id={manageId} className="text-section text-ink">
          {t.home.manageHeading}
        </h2>
        <div className="mt-q12">
          <RowList>
            {rows.map((row) => (
              <CountLinkRow key={row.href} href={row.href} label={row.label} count={formatInteger(locale, row.count)} />
            ))}
          </RowList>
        </div>
      </section>

      <section aria-labelledby={statusId}>
        <h2 id={statusId} className="text-section text-ink">
          {t.home.editionsByStatus}
        </h2>
        <ul className="mt-q12 flex flex-wrap gap-q8">
          {EDITION_STATUSES.map((status) => (
            <li key={status} className="rounded-sm border border-divider bg-surface px-q12 py-q4 text-body-compact text-ink">
              {statusLabel(t, status)}
              {": "}
              <bdi>{formatInteger(locale, counts.editions[status] ?? 0)}</bdi>
            </li>
          ))}
        </ul>
      </section>

      <AiCard ai={overview.ai} />

      <section aria-labelledby={editionsId}>
        <h2 id={editionsId} className="text-section text-ink">
          {t.home.editionsHeading}
        </h2>
        {overview.editions.length === 0 ? (
          <p className="mt-q12 text-body text-ink-secondary">{t.home.editionsEmpty}</p>
        ) : (
          <ul className="mt-q12 flex flex-col gap-q12">
            {overview.editions.map((edition) => (
              <EditionRowLink key={edition.id} edition={edition} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// A row of the list of destinations: the name at the start, the count and the chevron at the end. The chevron is the back arrow turned half a turn
// (it already mirrors in right-to-left), so it points to the end edge in both directions.
function CountLinkRow({ href, label, count }: { href: string; label: string; count: string }) {
  return (
    <li className="not-last:border-b not-last:border-divider">
      <Link
        href={href}
        className="flex min-h-row items-center justify-between gap-q12 px-q16 py-q8 text-start text-body text-ink transition-[background-color] duration-(--q-duration-fast) hover:bg-selection active:bg-selection focus-visible:outline-offset-[-2px]"
      >
        <span>{label}</span>
        <span className="flex shrink-0 items-center gap-q12 text-small text-ink-secondary">
          <bdi>{count}</bdi>
          <span aria-hidden="true" className="flex rotate-180">
            <Icon name="back" size="md" />
          </span>
        </span>
      </Link>
    </li>
  );
}

function EditionRowLink({ edition }: { edition: EditionSummary }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  return (
    <li>
      <Link
        href={`/admin/editions/${encodeURIComponent(edition.id)}`}
        className="flex flex-wrap items-start justify-between gap-q12 rounded-md border border-divider bg-surface p-q16 transition-[background-color] duration-(--q-duration-fast) hover:bg-selection focus-visible:outline-offset-[-2px]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-body font-semibold text-ink">
            <Mixed>{bookTitle(locale, edition.book)}</Mixed>
          </span>
          <span className="block text-small text-ink-secondary">
            <Mixed>{edition.editionLabel}</Mixed>
            {" · "}
            {t.home.version(formatInteger(locale, edition.version))}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-q8">
          <StatusChip status={edition.status} />
          {edition.catalogHidden ? <HiddenMark /> : null}
        </span>
      </Link>
    </li>
  );
}

// The read-only AI card (section 7): what is configured and what the in-process ledger counted. It has no control, and says so.
function AiCard({ ai }: { ai: AiStatus }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const headingId = useId();
  const a = t.home.ai;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-section text-ink">
        {t.home.aiHeading}
      </h2>
      <div className="mt-q12">
        <Notice>{t.home.aiNote}</Notice>
      </div>
      <div className="mt-q12">
        <InfoList>
          <InfoRow label={a.chat}>{ai.chatModelForLearners ? a.chatOn : a.chatOff}</InfoRow>
          <InfoRow label={a.provider}>{ai.providerConfigured ? a.providerOn : a.providerOff}</InfoRow>
          <InfoRow label={a.models}>
            {ai.models.length === 0 ? (
              a.noModels
            ) : (
              <ul className="flex flex-col gap-q4">
                {ai.models.map((model) => (
                  <li key={model}>
                    <Technical>{model}</Technical>
                  </li>
                ))}
              </ul>
            )}
          </InfoRow>
          <InfoRow label={a.dailyCap}>{formatCount(locale, ai.dailyCap, t)}</InfoRow>
          <InfoRow label={a.usedToday}>{formatCount(locale, ai.usedToday, t)}</InfoRow>
          <InfoRow label={a.usedLastMinute}>{formatCount(locale, ai.usedLastMinute, t)}</InfoRow>
        </InfoList>
      </div>
      <p className="mt-q8 text-small text-ink-secondary">{a.footnote}</p>
    </section>
  );
}
