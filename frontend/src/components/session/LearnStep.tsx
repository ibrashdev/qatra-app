"use client";

import { Fragment } from "react";
import { QuestionSource, type TextKind } from "@/components/questions";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { TextButton } from "@/components/ui/TextButton";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";
import { sessionMessages } from "@/i18n/session-messages";
import type { PassageView } from "@/lib/api/types";
import { cx } from "@/lib/cx";
import { needsLegend, segmentUnit } from "./session-model";

// The learn step (UI-screens S-19 c7 to c14): the passage as received, in its whole unit, with today's range marked; the source line; for a hadith the
// record block and, only when the snapshot says so, the D50 notice; the hide toggle; the instruction. The primary button lives in the action bar.
// Hidden text is removed from the page and the accessibility tree, not blurred (UI-tokens 6.12).
export function LearnStep({ passage, textKind, hidden, onToggle }: { passage: PassageView; textKind: TextKind; hidden: boolean; onToggle: () => void }) {
  const { locale, direction } = useLocale();
  const t = sessionMessages(locale).learn;
  const notice = questionMessages(locale).d50Notice;
  const unitSegments = passage.units.map((unit) => ({ unit, segments: segmentUnit(unit, passage.highlight) }));
  const showLegend = needsLegend(unitSegments.map((entry) => entry.segments));
  const hadith = textKind === "hadith";

  return (
    <div className="flex flex-col gap-q24">
      <div className="flex flex-col gap-q8">
        <h2 data-step-heading tabIndex={-1} className="text-section text-ink">
          {t.heading}
        </h2>
        <p className="text-body-compact text-ink-secondary">
          <bdi lang="ar">{passage.sectionTitleAr}</bdi> {"·"} <bdi lang="ar">{passage.reference}</bdi>
        </p>
        {hadith ? (
          <span className="inline-flex min-h-badge w-fit items-center rounded-sm bg-selection px-q12 text-caption text-primary-deep">{t.paths[passage.path]}</span>
        ) : null}
      </div>

      {hidden ? (
        <p className="rounded-md bg-surface px-q16 py-q16 text-body-compact text-ink-secondary">{t.hiddenNote}</p>
      ) : (
        <div className="flex flex-col gap-q8">
          <div
            dir="rtl"
            lang="ar"
            aria-label={t.textLabel}
            role="group"
            className={cx(
              "flex flex-col gap-q12 rounded-md bg-surface px-q16 py-q16 text-start text-ink [overflow-wrap:anywhere] tablet:px-q24",
              textKind === "quran" ? "font-quran text-quran" : "font-hadith text-hadith",
            )}
          >
            {unitSegments.map(({ unit, segments }) => (
              <p key={unit.unitRef}>
                {segments.map((segment, position) => (
                  <Fragment key={position}>
                    {segment.marked ? <mark className="bg-selection text-ink [box-decoration-break:clone]">{segment.text}</mark> : segment.text}
                  </Fragment>
                ))}
              </p>
            ))}
          </div>
          {showLegend ? <p className="text-small text-ink-secondary">{t.legend}</p> : null}
        </div>
      )}

      <QuestionSource source={passage.source} />

      {hadith ? (
        <div lang={locale} dir={direction} className="flex flex-col gap-q4 text-small text-ink-secondary">
          <p>
            {t.takhrij} <bdi lang="ar">{passage.takhrij ?? t.notStated}</bdi>
          </p>
          <p>
            {t.grade} <bdi lang="ar">{passage.grade ?? t.notStated}</bdi>
          </p>
        </div>
      ) : null}
      {passage.showD50Notice ? <Notice>{notice}</Notice> : null}

      <div>
        <TextButton aria-pressed={hidden} onClick={onToggle}>
          <Icon name={hidden ? "eye" : "eye-off"} size="md" />
          {hidden ? t.show : t.hide}
        </TextButton>
      </div>

      <p className="text-body text-ink">{t.instruction}</p>
    </div>
  );
}
