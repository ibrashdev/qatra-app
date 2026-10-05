"use client";

import { useId } from "react";
import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { learningCueMessages } from "@/i18n/games-messages";

// FC-13 (docs/Figma-code-handoff.md): the explanatory learning-cycle cue of the games. Static and explanatory only: it shows no earned state, takes no
// data and changes no progress value. The exact confirmation rules stay in D66 and the contract; nothing here encodes them.
// The reference is 342 by 136 px with 12 px padding and 8 px gaps; here the box is as wide as its column, the three stages wrap onto further rows
// when the width or the text size does not allow one row, and the sequence follows the reading direction (the first stage at the start edge).
export function LearningCue() {
  const { locale } = useLocale();
  const t = learningCueMessages(locale);
  const headingId = useId();

  return (
    <div role="note" aria-labelledby={headingId} data-learning-cue className="flex flex-col gap-q8 rounded-md border border-divider bg-surface p-q12">
      <p id={headingId} className="text-small font-semibold text-ink">
        {t.heading}
      </p>
      <ol className="flex flex-wrap items-stretch gap-q8">
        {t.stages.map((stage, index) => (
          <li key={stage} className="flex min-w-0 flex-1 basis-28 items-center gap-q8">
            <span className="flex min-h-target min-w-0 flex-1 items-center justify-center rounded-sm border border-edge bg-page px-q8 py-q4 text-center text-small text-ink">{stage}</span>
            {index < t.stages.length - 1 ? (
              // Decorative: the list order already says the sequence. The back arrow points away from the next stage in either direction, so it is turned round.
              <span aria-hidden="true" className="flex shrink-0 rotate-180 text-ink-secondary">
                <Icon name="back" size="md" />
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="text-caption font-normal text-ink-secondary">{t.caption}</p>
    </div>
  );
}
