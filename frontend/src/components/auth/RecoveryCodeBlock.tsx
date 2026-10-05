"use client";

import { Fragment, useId, type ClipboardEvent, type Ref } from "react";

// The first line holds the first four groups and the second line the rest.
const LINES = [
  [0, 4],
  [4, 8],
] as const;

// UI-tokens 6.15 and S-04 section 3: the code in eight groups of four, as two lines of four groups at every width, so it is dictated the same
// way on every device. It is left to right, never translated, set in the mono face, and selected whole by a press (user-select: all).
// The block is not focusable and holds no second copy of the code: the visible text is what assistive technology reads, by character.
// The dash between the two lines is in the text, in the selection and in what is read, but it is set at font size zero, so it takes no room
// on screen (a line of 20 characters would not fit 272 px at 20 px). A hand copy of the selection is rewritten to the plain code with its
// dashes, so the line break never reaches the clipboard.
export function RecoveryCodeBlock({ groups, name, description, blockRef }: { groups: readonly string[]; name: string; description: string; blockRef?: Ref<HTMLDivElement> }) {
  const descriptionId = useId();

  function copyAsCode(event: ClipboardEvent<HTMLDivElement>) {
    event.clipboardData.setData("text/plain", groups.join("-"));
    event.preventDefault();
  }

  return (
    <>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
      <div
        ref={blockRef}
        role="group"
        aria-label={name}
        aria-describedby={descriptionId}
        dir="ltr"
        translate="no"
        onCopy={copyAsCode}
        className="select-all rounded-md border border-edge bg-surface p-q16 font-mono text-[1.25rem] leading-[1.8] text-ink"
      >
        {LINES.map(([from, to], line) => (
          // A line breaks only where a dash allows it, and only when the text is enlarged far past normal: no group is cut or scrolled away.
          <div key={line}>
            {groups.slice(from, to).map((group, position) => (
              <Fragment key={position}>
                {position > 0 ? (
                  <>
                    -<wbr />
                  </>
                ) : null}
                <span>{group}</span>
              </Fragment>
            ))}
            {line === 0 ? <span className="text-[0px]">-</span> : null}
          </div>
        ))}
      </div>
    </>
  );
}
