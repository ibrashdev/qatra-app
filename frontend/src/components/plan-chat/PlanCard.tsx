"use client";

import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatInteger } from "@/i18n/format";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import type { PlanProposal, PlanSections } from "@/lib/api/types";
import { isolateDates } from "./isolate-dates";

const SECTION_ORDER: readonly (keyof PlanSections)[] = ["goal", "totalTime", "dailyTime", "stages", "reviews", "nextStep"];

// UI-screens S-34 c7 and c8, P-13. The six sections are printed as received: no number is computed and no date is reformatted here.
// The current card is a section the confirm button describes; an earlier one is a collapsed disclosure with the chip «سابق» and no actions.
export function PlanCard({ proposal, current, domId }: { proposal: PlanProposal; current: boolean; domId?: string }) {
  const { locale } = useLocale();
  const text = planChatMessages(locale);
  const formatted = formatInteger(locale, proposal.proposalVersion);

  const body = (
    <>
      {/* The chip row takes focus after a stale proposal was replaced (G-37). */}
      <p data-card-chip tabIndex={-1} className="flex">
        <span
          className={cx(
            "inline-flex items-center gap-q4 rounded-sm px-q8 py-q4 text-caption",
            current ? "border border-info-edge bg-info-tint text-info-ink" : "bg-disabled text-ink",
          )}
        >
          {current ? <Icon name="info" size="sm" /> : null}
          {current ? text.card.current(formatted) : text.card.earlier}
        </span>
      </p>
      <dl className="mt-q12 flex flex-col gap-q12">
        {SECTION_ORDER.map((key) => (
          <div key={key}>
            <dt className="text-section text-ink">{text.card.labels[key]}</dt>
            <dd dir="auto" className="mt-q4 text-body-compact text-ink">
              {isolateDates(proposal.sections[key])}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );

  if (current) {
    return (
      <section id={domId} data-current-card className="w-full rounded-md border border-divider bg-surface p-q16">
        {body}
      </section>
    );
  }
  return (
    <details className="w-full rounded-md border border-divider bg-surface">
      <summary className="flex min-h-row cursor-pointer items-center px-q16 text-body-compact text-ink">{text.thread.earlierProposal(formatted)}</summary>
      <div className="px-q16 pb-q16">{body}</div>
    </details>
  );
}
