"use client";

import type { MouseEvent } from "react";
import { Banner } from "./Banner";

export interface ErrorSummaryItem {
  fieldId: string; // the id of the input the message belongs to
  message: string;
}

// P-03: from two errors on, an error banner under the heading lists each message as a link that focuses its field.
// Focus itself goes to the first invalid field; this banner is announced as an alert.
export function ErrorSummary({ title, items }: { title: string; items: readonly ErrorSummaryItem[] }) {
  function focusField(event: MouseEvent<HTMLAnchorElement>, fieldId: string) {
    event.preventDefault();
    document.getElementById(fieldId)?.focus();
  }

  return (
    <Banner variant="error" role="alert" title={title}>
      <ul>
        {items.map((item) => (
          <li key={item.fieldId}>
            <a
              href={`#${item.fieldId}`}
              onClick={(event) => focusField(event, item.fieldId)}
              className="inline-flex min-h-target items-center rounded-sm underline underline-offset-4"
            >
              {item.message}
            </a>
          </li>
        ))}
      </ul>
    </Banner>
  );
}
