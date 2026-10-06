"use client";

import { useId, useState, type ReactNode } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { TextLink } from "@/components/ui/TextLink";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { formatInteger } from "@/i18n/format";
import { archiveEdition, deleteEdition, getEdition, unarchiveEdition } from "@/lib/api/admin-endpoints";
import type { EditionDetail, EditionSectionRow, SectionDetail } from "@/lib/api/admin-types";
import { bookTitle, formatTimestamp, hasEditionActions, languageLabel, presentRows, rightsLabel, sectionTitle, statusLabel, withdrawReasonLabel } from "./admin-model";
import { ActionFailure } from "./AdminFailureBanner";
import { AdminFrame, type FrameControls } from "./AdminFrame";
import { ConfirmDelete } from "./ConfirmDelete";
import { EditionLabelDialog, SectionTitlesDialog } from "./EntityDialogs";
import { InfoList, InfoRow, Mixed, Technical } from "./InfoList";
import { HiddenMark, StatusChip } from "./StatusChip";
import { useAdminAction } from "./use-admin-action";
import { useAdminResource } from "./use-admin-resource";
import { useHeadingFocus } from "./use-heading-focus";
import { WithdrawDialog } from "./WithdrawDialog";

// AD-02 Edition (docs/Content-admin.md sections 5 and 6): the details, the approval and withdrawal records, the counts, the actions the server says
// are allowed (rename, hide or show, withdraw with a reason and a note, delete a draft), the sections with their rename and a link to AD-03, and
// the job history. Hiding is reversible and is done at once; withdrawing and deleting are asked for first. The toast needs a provider that the app
// shell does not have, so the screen carries its own.
export function EditionScreen({ id }: { id: string }) {
  return (
    <ToastProvider>
      <EditionContent id={id} />
    </ToastProvider>
  );
}

function EditionContent({ id }: { id: string }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const next = `/admin/editions/${encodeURIComponent(id)}`;
  const resource = useAdminResource(id, (client, signal) => getEdition(client, id, { signal }));
  return (
    <AdminFrame title={t.screens.edition} back={{ destination: t.screenName, href: "/admin" }} next={next} resource={resource}>
      {(edition, controls) => <EditionBody edition={edition} next={next} controls={controls} />}
    </AdminFrame>
  );
}

type OpenDialog = "rename" | "withdraw" | "delete" | null;

function Section({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-section text-ink">
        {heading}
      </h2>
      <div className="mt-q12">{children}</div>
    </section>
  );
}

function EditionBody({ edition, next, controls }: { edition: EditionDetail; next: string; controls: FrameControls<EditionDetail> }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const e = t.edition;
  const toast = useToast();
  const action = useAdminAction(next);
  const focusHeading = useHeadingFocus();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [editingSection, setEditingSection] = useState<EditionSectionRow | null>(null);
  const [deleted, setDeleted] = useState(false);
  const detailsId = useId();
  const approvalId = useId();
  const withdrawalId = useId();
  const countsId = useId();
  const actionsId = useId();
  const sectionsId = useId();
  const jobsId = useId();

  const { actions } = edition;
  const title = bookTitle(locale, edition.book);
  const number = (value: number) => formatInteger(locale, value);

  function replaceEdition(updated: EditionDetail) {
    controls.replace(() => updated);
  }

  // The row changed or vanished under the manager: the dialogs close and the page reads again.
  function reload() {
    setDialog(null);
    setEditingSection(null);
    controls.reload();
  }

  async function toggleVisibility(hide: boolean) {
    const send = hide ? archiveEdition : unarchiveEdition;
    const result = await action.run(hide ? "hide" : "show", (client) => send(client, edition.id, { expectedUpdatedAt: edition.updatedAt }));
    if (!result.ok) return;
    replaceEdition(result.value);
    toast.show(hide ? t.toasts.hidden : t.toasts.shown);
  }

  async function remove() {
    setDialog(null);
    const result = await action.run("delete", (client) => deleteEdition(client, edition.id, { expectedUpdatedAt: edition.updatedAt }));
    if (!result.ok) return;
    setDeleted(true);
    toast.show(t.toasts.deleted);
    focusHeading();
  }

  function renamed(updated: EditionDetail) {
    replaceEdition(updated);
    setDialog(null);
    toast.show(t.toasts.saved);
  }

  function withdrawn(updated: EditionDetail) {
    replaceEdition(updated);
    setDialog(null);
    toast.show(t.toasts.withdrawn);
    focusHeading();
  }

  function sectionRenamed(saved: SectionDetail) {
    controls.replace((current) => ({
      ...current,
      sections: current.sections.map((row) => (row.id === saved.id ? { ...row, titleAr: saved.titleAr, titleEn: saved.titleEn } : row)),
    }));
    setEditingSection(null);
    toast.show(t.toasts.saved);
  }

  if (deleted) {
    return (
      <div className="mt-q24 flex flex-col items-start gap-q16">
        <Banner variant="success">{t.toasts.deleted}</Banner>
        <TextLink href="/admin">{t.screenName}</TextLink>
      </div>
    );
  }

  const otherTitle = locale === "ar" ? edition.book.titleEn : edition.book.titleAr;

  // The records come from `review_record`, and every field of them may be null: a row is shown only for a value that is there. The owner's approval
  // words are text in either script, so they sit in an isolate of their own direction.
  const { approval, withdrawal } = edition;
  const approvalRows = approval === null ? [] : presentRows([
    [e.approval.who, approval.who, (value) => <Mixed>{value}</Mixed>],
    [e.approval.at, approval.at, (value) => formatTimestamp(locale, value)],
    [e.approval.scope, approval.scope, (value) => <Mixed>{value}</Mixed>],
    [e.approval.words, approval.words, (value) => <Mixed>{value}</Mixed>],
    [e.approval.source, approval.source, (value) => <Mixed>{value}</Mixed>],
  ]);
  const withdrawalRows = withdrawal === null ? [] : presentRows([
    [e.withdrawal.reason, withdrawal.reason, (value) => <Mixed>{withdrawReasonLabel(t, value)}</Mixed>],
    [e.withdrawal.note, withdrawal.note, (value) => <Mixed>{value}</Mixed>],
    [e.withdrawal.at, withdrawal.at, (value) => formatTimestamp(locale, value)],
  ]);

  return (
    <div className="mt-q24 flex flex-col gap-q24">
      <div>
        <h2 className="text-section text-ink">
          <Mixed>{title}</Mixed>
        </h2>
        {otherTitle === null || otherTitle === "" || otherTitle === title ? null : (
          <p className="mt-q4 text-body-compact text-ink-secondary">
            <Mixed>{otherTitle}</Mixed>
          </p>
        )}
        <p className="mt-q4 text-body-compact text-ink-secondary">
          <Mixed>{edition.editionLabel}</Mixed>
        </p>
        <div className="mt-q12 flex flex-wrap items-center gap-q8">
          <StatusChip status={edition.status} />
          {edition.catalogHidden ? <HiddenMark /> : null}
        </div>
        <ActionFailure failure={action.failure} onReload={reload} />
      </div>

      <Section id={detailsId} heading={e.detailsHeading}>
        <InfoList>
          <InfoRow label={e.fields.key}>
            <Technical>{edition.editionKey}</Technical>
          </InfoRow>
          <InfoRow label={e.fields.label}>
            <Mixed>{edition.editionLabel}</Mixed>
          </InfoRow>
          <InfoRow label={e.fields.language}>{languageLabel(t, edition.language)}</InfoRow>
          <InfoRow label={e.fields.version}>{number(edition.version)}</InfoRow>
          <InfoRow label={e.fields.bankVersion}>{number(edition.bankVersion)}</InfoRow>
          <InfoRow label={e.fields.status}>{statusLabel(t, edition.status)}</InfoRow>
          {edition.status === "published" ? <InfoRow label={e.fields.visibility}>{edition.catalogHidden ? t.hiddenMark : e.fields.visible}</InfoRow> : null}
          {edition.archivedAt === null ? null : <InfoRow label={e.fields.hiddenSince}>{formatTimestamp(locale, edition.archivedAt)}</InfoRow>}
          <InfoRow label={e.fields.source}>
            <Mixed>{edition.source.title}</Mixed>
          </InfoRow>
          <InfoRow label={e.fields.provider}>
            <Mixed>{edition.source.provider}</Mixed>
          </InfoRow>
          <InfoRow label={e.fields.rights}>{rightsLabel(t, edition.source.rightsStatus)}</InfoRow>
          <InfoRow label={e.fields.hash}>{edition.contentHash === null ? t.none : <Technical>{edition.contentHash}</Technical>}</InfoRow>
          <InfoRow label={e.fields.updated}>{formatTimestamp(locale, edition.updatedAt)}</InfoRow>
        </InfoList>
      </Section>

      {approvalRows.length === 0 ? null : (
        <Section id={approvalId} heading={e.approvalHeading}>
          <InfoList>
            {approvalRows.map((row) => (
              <InfoRow key={row.label} label={row.label}>
                {row.value}
              </InfoRow>
            ))}
          </InfoList>
        </Section>
      )}

      {withdrawalRows.length === 0 ? null : (
        <Section id={withdrawalId} heading={e.withdrawalHeading}>
          <InfoList>
            {withdrawalRows.map((row) => (
              <InfoRow key={row.label} label={row.label}>
                {row.value}
              </InfoRow>
            ))}
          </InfoList>
        </Section>
      )}

      <Section id={countsId} heading={e.countsHeading}>
        <InfoList>
          <InfoRow label={e.counts.sections}>{number(edition.counts.sections)}</InfoRow>
          <InfoRow label={e.counts.units}>{number(edition.counts.units)}</InfoRow>
          <InfoRow label={e.counts.passages}>{number(edition.counts.passages)}</InfoRow>
          <InfoRow label={e.counts.lessons}>{number(edition.counts.lessons)}</InfoRow>
          <InfoRow label={e.counts.questions}>{number(edition.counts.questions)}</InfoRow>
        </InfoList>
      </Section>

      <Section id={actionsId} heading={e.actionsHeading}>
        <div className="flex flex-wrap gap-q12">
          {actions.editLabel ? (
            <Button variant="secondary" onClick={() => setDialog("rename")}>
              {e.actions.rename}
            </Button>
          ) : null}
          {actions.archive ? (
            <Button variant="secondary" loading={action.busy === "hide"} onClick={() => void toggleVisibility(true)}>
              {e.actions.hide}
            </Button>
          ) : null}
          {actions.unarchive ? (
            <Button variant="secondary" loading={action.busy === "show"} onClick={() => void toggleVisibility(false)}>
              {e.actions.show}
            </Button>
          ) : null}
          {actions.withdraw ? (
            <Button variant="secondary" onClick={() => setDialog("withdraw")}>
              {e.actions.withdraw}
            </Button>
          ) : null}
          {actions.delete ? (
            <Button variant="secondary" loading={action.busy === "delete"} onClick={() => setDialog("delete")}>
              {e.actions.deleteDraft}
            </Button>
          ) : null}
        </div>
        {hasEditionActions(actions) ? null : <p className="mt-q12 text-body-compact text-ink-secondary">{e.noActions}</p>}
        {actions.archive || actions.unarchive || actions.withdraw ? (
          <div className="mt-q12">
            <Notice>{e.reversibleNote}</Notice>
          </div>
        ) : null}
      </Section>

      <Section id={sectionsId} heading={e.sectionsHeading}>
        {edition.status === "revoked" ? (
          <div className="mb-q12">
            <Notice>{t.section.renameBlocked}</Notice>
          </div>
        ) : null}
        {edition.sections.length === 0 ? (
          <p className="text-body text-ink-secondary">{e.sectionsEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-q12">
            {edition.sections.map((row) => {
              const name = sectionTitle(locale, row);
              const other = locale === "ar" ? row.titleEn : row.titleAr;
              return (
                <li key={row.id} className="rounded-md border border-divider bg-surface p-q16">
                  <h3 className="text-body font-semibold text-ink">
                    <Mixed>{name}</Mixed>
                  </h3>
                  {other === "" || other === name ? null : (
                    <p className="text-small text-ink-secondary">
                      <Mixed>{other}</Mixed>
                    </p>
                  )}
                  <p className="mt-q4 text-small text-ink-secondary">
                    {e.reference}
                    {": "}
                    <Technical>{row.reference}</Technical>
                    {" · "}
                    <Technical>{row.kind}</Technical>
                  </p>
                  <div className="mt-q12 flex flex-wrap items-center gap-q12">
                    {edition.status === "revoked" ? null : (
                      <Button variant="secondary" aria-label={t.names.rename(name)} onClick={() => setEditingSection(row)}>
                        {e.renameSection}
                      </Button>
                    )}
                    {/* The visible word is short; the name says which section, and contains the visible word (WCAG 2.5.3). */}
                    <TextLink href={`/admin/sections/${encodeURIComponent(row.id)}`}>
                      <span aria-hidden="true">{t.buttons.view}</span>
                      <span className="sr-only">{t.names.view(name)}</span>
                    </TextLink>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id={jobsId} heading={e.jobsHeading}>
        {edition.jobs.length === 0 ? (
          <p className="text-body text-ink-secondary">{e.jobsEmpty}</p>
        ) : (
          <ol className="flex flex-col gap-q8">
            {edition.jobs.map((job, index) => (
              <li key={`${job.step}-${index}`} className="rounded-md border border-divider bg-surface px-q16 py-q12 text-body-compact text-ink">
                <span className="font-semibold">
                  <Technical>{job.step}</Technical>
                </span>
                {" · "}
                <Technical>{job.status}</Technical>
                <span className="block text-small text-ink-secondary">{formatTimestamp(locale, job.updatedAt)}</span>
                {job.publishedAt === null ? null : (
                  <span className="block text-small text-ink-secondary">
                    {e.publishedAt}
                    {": "}
                    {formatTimestamp(locale, job.publishedAt)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>

      {dialog === "rename" ? <EditionLabelDialog edition={edition} next={next} onSaved={renamed} onCancel={() => setDialog(null)} onReload={reload} /> : null}
      {dialog === "withdraw" ? <WithdrawDialog edition={edition} next={next} onWithdrawn={withdrawn} onCancel={() => setDialog(null)} onReload={reload} /> : null}
      {editingSection === null ? null : (
        <SectionTitlesDialog key={editingSection.id} section={editingSection} next={next} onSaved={sectionRenamed} onCancel={() => setEditingSection(null)} onReload={reload} />
      )}
      <ConfirmDelete
        target={dialog === "delete" ? { name: edition.editionLabel } : null}
        copy={e.deleteDialog}
        onConfirm={() => void remove()}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
