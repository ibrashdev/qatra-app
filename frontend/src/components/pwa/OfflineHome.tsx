"use client";

import { Fragment, useId, useMemo, useState } from "react";
import { QuestionSource, type TextKind } from "@/components/questions";
import { needsLegend, segmentUnit } from "@/components/session/session-model";
import { ProgressBar } from "@/components/today/ProgressBar";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { TextButton } from "@/components/ui/TextButton";
import { formatInteger } from "@/i18n/format";
import { gamesMessages } from "@/i18n/games-messages";
import { sessionMessages } from "@/i18n/session-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { offlineMessages } from "@/i18n/offline-messages";
import type { DailyProgress, PassageView, PlanSnapshot } from "@/lib/api/types";
import { cx } from "@/lib/cx";
import type { OutboxCounts, SyncProgress } from "@/lib/offline/types";
import { ClearLocalControl } from "./ClearLocalControl";
import { InstallPrompt } from "./InstallPrompt";
import { absentGames, snapshotTextKind, type OfflineSessionEntry } from "./offline-model";
import { SyncStatus } from "./SyncStatus";

// S-31 "local ready": the day as the device can state it. The chip says the plan is ready offline, the line says results wait for verification, the figure
// is the provisional minutes (never a completed day), and each prepared session is a row with one button. Everything here reads the downloaded snapshot;
// nothing asks the server, and nothing links to a route (a router transition would need the network).
export function OfflineHome({
  snapshot,
  daily,
  entries,
  counts,
  progress,
  connected,
  shellReady,
  blocked,
  onStart,
  onSync,
  onCleared,
}: {
  snapshot: PlanSnapshot;
  daily: DailyProgress;
  entries: readonly OfflineSessionEntry[];
  counts: OutboxCounts;
  progress: SyncProgress;
  // The device can reach the server (or believes it can): the status line is the offline one only when it cannot.
  connected: boolean;
  // The worker has cached every file of the shell (null while unknown). The chip says «ready» only when this and the plan are both ready.
  shellReady: boolean | null;
  // A banner already says why nothing may start (stale, mismatch): the rows stay informative but inert.
  blocked: boolean;
  onStart: (entry: OfflineSessionEntry) => void;
  onSync: () => void;
  onCleared: () => void;
}) {
  const { locale } = useLocale();
  const t = offlineMessages(locale);
  const games = gamesMessages(locale).games;
  const progressId = useId();
  const sessionsId = useId();
  const absent = useMemo(() => absentGames(snapshot, entries), [snapshot, entries]);

  const doneMinutes = formatInteger(locale, Math.floor(daily.dailyActiveMs / 60000));
  const goalMinutes = formatInteger(locale, Math.round(daily.dailyGoalMs / 60000));
  const valueText = t.home.provisionalMinutes(doneMinutes, goalMinutes);

  return (
    <div className="flex flex-col gap-q24">
      <div className="flex flex-col gap-q12">
        <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-q12">
          {shellReady === true ? (
            <span className="inline-flex min-h-badge items-center gap-q4 rounded-sm bg-success-tint px-q12 text-caption text-success-ink">
              <Icon name="success" size="sm" />
              {t.shell.ready}
            </span>
          ) : shellReady === false ? (
            <p className="text-body-compact text-ink-secondary">{t.download.shellPending}</p>
          ) : null}
        </div>
        {!connected ? <p className="text-body-compact text-ink-secondary">{t.shell.offlinePending}</p> : null}
      </div>

      <section aria-labelledby={progressId} className="flex flex-col gap-q8">
        <h2 id={progressId} className="text-section text-ink">
          {t.home.progressHeading}
        </h2>
        <ProgressBar percent={daily.dailyPercent} labelledBy={progressId} valueText={valueText} />
        <p className="text-body-compact text-ink">{valueText}</p>
        <p className="text-small text-ink-secondary">{t.home.provisionalNote}</p>
      </section>

      <section aria-labelledby={sessionsId} className="flex flex-col gap-q12">
        <h2 id={sessionsId} className="text-section text-ink">
          {t.home.sessionsHeading}
        </h2>
        <ul className="flex flex-col gap-q8">
          {entries.map((entry) => {
            const name = entry.kind === "daily" ? t.home.daily : games[entry.kind].name;
            const hint = entry.kind === "daily" ? t.home.dailyHint : games[entry.kind].description;
            const off = blocked || !entry.runnable;
            return (
              <li key={entry.session.sessionId} className="flex flex-col gap-q8 rounded-md border border-divider bg-surface p-q16 tablet:flex-row tablet:items-center tablet:justify-between">
                <div className="min-w-0">
                  <p className="text-section text-ink">{name}</p>
                  <p className="text-body-compact text-ink-secondary">{hint}</p>
                  {!entry.runnable && !blocked ? <p className="mt-q4 text-small text-ink-secondary">{t.home.needsConnection}</p> : null}
                </div>
                <div className="shrink-0">
                  <Button aria-label={t.home.startLabel(name)} aria-disabled={off || undefined} onClick={() => !off && onStart(entry)}>
                    {t.home.start}
                  </Button>
                </div>
              </li>
            );
          })}
          {absent.map(({ kind, reason }) => (
            <li key={kind} className="flex flex-col gap-q4 rounded-md border border-divider bg-surface p-q16">
              <p className="text-section text-ink">{games[kind].name}</p>
              <p className="text-small text-ink-secondary">{reason === "no_material" ? t.home.notAvailable : t.home.needsConnection}</p>
            </li>
          ))}
        </ul>
      </section>

      <SyncStatus counts={counts} progress={progress} onSync={onSync} />

      <Lessons lessons={snapshot.lessons} textKind={snapshotTextKind(snapshot)} />

      <InstallPrompt />

      <ClearLocalControl unsynced={counts.total} onCleared={onCleared} />
    </div>
  );
}

// The downloaded lesson text, read only (offline-spec 2.1). The text is shown as received with the passage range marked, the canonical source line beside it
// (D68). It stays collapsed until asked for, so a long plan does not push the sessions off the screen.
function Lessons({ lessons, textKind }: { lessons: readonly PassageView[]; textKind: TextKind }) {
  const { locale } = useLocale();
  const t = offlineMessages(locale).home;
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (lessons.length === 0) return <p className="text-small text-ink-secondary">{t.lessonsEmpty}</p>;
  return (
    <section className="flex flex-col gap-q12">
      <h2 className="text-section text-ink">{t.lessonsHeading}</h2>
      <div>
        <TextButton aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((value) => !value)}>
          <Icon name={open ? "eye-off" : "eye"} size="md" />
          {open ? t.lessonsHide : t.lessonsOpen}
        </TextButton>
      </div>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-q16">
        {open ? lessons.map((passage) => <LessonText key={passage.passageId} passage={passage} textKind={textKind} />) : null}
      </div>
    </section>
  );
}

function LessonText({ passage, textKind }: { passage: PassageView; textKind: TextKind }) {
  const { locale } = useLocale();
  const legend = sessionMessages(locale).learn.legend;
  const unitSegments = passage.units.map((unit) => ({ unit, segments: segmentUnit(unit, passage.highlight) }));
  const showLegend = needsLegend(unitSegments.map((entry) => entry.segments));
  return (
    <article className="flex flex-col gap-q8">
      <h3 className="text-body text-ink">
        <bdi lang="ar">{passage.sectionTitleAr}</bdi> {"·"} <bdi lang="ar">{passage.reference}</bdi>
      </h3>
      <div
        dir="rtl"
        lang="ar"
        className={cx(
          "flex flex-col gap-q12 rounded-md bg-surface px-q16 py-q16 text-start text-ink [overflow-wrap:anywhere] tablet:px-q24",
          textKind === "quran" ? "font-quran text-quran" : "font-hadith text-hadith",
        )}
      >
        {unitSegments.map(({ unit, segments }) => (
          <p key={unit.unitRef}>
            {segments.map((segment, position) => (
              <Fragment key={position}>{segment.marked ? <mark className="bg-selection text-ink [box-decoration-break:clone]">{segment.text}</mark> : segment.text}</Fragment>
            ))}
          </p>
        ))}
      </div>
      {showLegend ? <p className="text-small text-ink-secondary">{legend}</p> : null}
      <QuestionSource source={passage.source} />
    </article>
  );
}
