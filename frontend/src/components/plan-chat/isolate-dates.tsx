import type { ReactNode } from "react";

const ISO_DATE = /((?<![0-9٠-٩])[0-9٠-٩]{4}-[0-9٠-٩]{2}-[0-9٠-٩]{2}(?![0-9٠-٩]))/;

// The server writes dates into its plain texts as YYYY-MM-DD. Each one is isolated from the surrounding sentence (so the bidi algorithm cannot
// mix it into an Arabic line) and never wraps at its hyphens. The characters are never changed (P-13: texts are shown as received); text
// without a date is returned as the same string.
export function isolateDates(text: string): ReactNode {
  const parts = text.split(ISO_DATE);
  if (parts.length === 1) return text;
  // A split with one capture group puts the dates at the odd positions.
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <bdi key={index} dir="ltr" className="whitespace-nowrap">
        {part}
      </bdi>
    ) : (
      part
    ),
  );
}
