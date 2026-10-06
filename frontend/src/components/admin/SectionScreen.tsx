"use client";

import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { formatInteger } from "@/i18n/format";
import { getSection } from "@/lib/api/admin-endpoints";
import type { SectionDetail } from "@/lib/api/admin-types";
import { cx } from "@/lib/cx";
import { sectionRenameAllowed, sectionTitle, unitFace } from "./admin-model";
import { AdminFrame, type FrameControls } from "./AdminFrame";
import { SectionTitlesDialog } from "./EntityDialogs";
import { InfoList, InfoRow, Mixed, Technical } from "./InfoList";
import { useAdminResource } from "./use-admin-resource";

// AD-03 Section (docs/Content-admin.md section 6): the section's titles with their rename, the question counts by game type, and the original text
// of its units, read only. The text is shown as the source has it, right to left, in the Quran face for an ayah and in the hadith face otherwise,
// and nothing here edits it. The toast needs a provider that the app shell does not have, so the screen carries its own.
export function SectionScreen({ id }: { id: string }) {
  return (
    <ToastProvider>
      <SectionContent id={id} />
    </ToastProvider>
  );
}

function SectionContent({ id }: { id: string }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const next = `/admin/sections/${encodeURIComponent(id)}`;
  const resource = useAdminResource(id, (client, signal) => getSection(client, id, { signal }));
  // The back control goes to the edition the section belongs to, once the read has said which; until then it goes to the admin home.
  const edition = resource.state.status === "ready" ? resource.state.data.edition : null;
  const back = edition === null ? { destination: t.screenName, href: "/admin" } : { destination: t.screens.edition, href: `/admin/editions/${encodeURIComponent(edition.id)}` };
  return (
    <AdminFrame title={t.screens.section} back={back} next={next} resource={resource}>
      {(section, controls) => <SectionBody section={section} next={next} controls={controls} />}
    </AdminFrame>
  );
}

function Block({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-section text-ink">
        {heading}
      </h2>
      <div className="mt-q12">{children}</div>
    </section>
  );
}

function SectionBody({ section, next, controls }: { section: SectionDetail; next: string; controls: FrameControls<SectionDetail> }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const s = t.section;
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const titlesId = useId();
  const infoId = useId();
  const questionsId = useId();
  const unitsId = useId();
  const number = (value: number) => formatInteger(locale, value);
  const canRename = sectionRenameAllowed(section);

  function saved(updated: SectionDetail) {
    controls.replace(() => updated);
    setRenaming(false);
    toast.show(t.toasts.saved);
  }

  function reload() {
    setRenaming(false);
    controls.reload();
  }

  return (
    <div className="mt-q24 flex flex-col gap-q24">
      <Block id={titlesId} heading={s.titlesHeading}>
        <InfoList>
          <InfoRow label={s.titleAr}>
            <Mixed>{section.titleAr}</Mixed>
          </InfoRow>
          <InfoRow label={s.titleEn}>
            <Mixed>{section.titleEn}</Mixed>
          </InfoRow>
        </InfoList>
        <div className="mt-q12">
          {canRename ? (
            <Button variant="secondary" aria-label={t.names.rename(sectionTitle(locale, section))} onClick={() => setRenaming(true)}>
              {s.rename}
            </Button>
          ) : (
            <Notice>{s.renameBlocked}</Notice>
          )}
        </div>
      </Block>

      <Block id={infoId} heading={s.infoHeading}>
        <InfoList>
          <InfoRow label={s.fields.ordinal}>{number(section.ordinal)}</InfoRow>
          <InfoRow label={s.fields.kind}>
            <Technical>{section.kind}</Technical>
          </InfoRow>
          <InfoRow label={s.fields.reference}>
            <Technical>{section.reference}</Technical>
          </InfoRow>
          <InfoRow label={s.fields.edition}>
            <Mixed>{section.edition.editionLabel}</Mixed>
          </InfoRow>
        </InfoList>
      </Block>

      <Block id={questionsId} heading={s.questionsHeading}>
        <InfoList>
          <InfoRow label={s.questionTypes.wordOrder}>{number(section.questionCounts.wordOrder)}</InfoRow>
          <InfoRow label={s.questionTypes.wordChoice}>{number(section.questionCounts.wordChoice)}</InfoRow>
          <InfoRow label={s.questionTypes.wordRecall}>{number(section.questionCounts.wordRecall)}</InfoRow>
          <InfoRow label={s.questionTypes.similarDistinction}>{number(section.questionCounts.similarDistinction)}</InfoRow>
        </InfoList>
      </Block>

      <Block id={unitsId} heading={s.unitsHeading}>
        <Notice>{t.sourceTextNote}</Notice>
        {section.units.length === 0 ? (
          <p className="mt-q12 text-body text-ink-secondary">{s.unitsEmpty}</p>
        ) : (
          <ol className="mt-q12 flex flex-col gap-q12">
            {section.units.map((unit) => {
              const quran = unitFace(unit.kind) === "quran";
              return (
                <li key={unit.id} className="rounded-md border border-divider bg-surface p-q16">
                  <p className="text-small text-ink-secondary">
                    <Technical>{unit.reference}</Technical>
                  </p>
                  {/* The text of the book: right to left and Arabic in both interface languages, never truncated, no letter spacing (P-20). */}
                  <p dir="rtl" lang="ar" className={cx("mt-q8 text-start text-ink [overflow-wrap:anywhere]", quran ? "font-quran text-quran" : "font-hadith text-hadith")}>
                    {unit.text}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </Block>

      {renaming ? <SectionTitlesDialog section={section} next={next} onSaved={saved} onCancel={() => setRenaming(false)} onReload={reload} /> : null}
    </div>
  );
}
