"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

// UI-tokens 6.7 list rows (settings): at least 56 px, 16 px inline padding, the label at the start, a value or status in the secondary colour or a
// chevron at the end edge, a 1 px divider between rows. The group is one bordered surface, and its clipping keeps the hover fill inside the corners.
export function RowList({ children }: { children: ReactNode }) {
  return <ul className="overflow-hidden rounded-md border border-divider bg-surface">{children}</ul>;
}

const ROW = "flex min-h-row items-center justify-between gap-q12 px-q16 py-q8";

export function ReadOnlyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className={cx(ROW, "not-last:border-b not-last:border-divider")}>
      <span className="text-body text-ink">{label}</span>
      <span className="min-w-0 text-small text-ink-secondary">{children}</span>
    </li>
  );
}

// A row that goes to another screen. The chevron is the back arrow turned half a turn: the arrow already mirrors in right-to-left, so the turned one
// points to the end edge in both directions. `danger` is the label of the delete row (`--q-color-error-text`).
export function LinkRow({ href, tone = "default", children }: { href: string; tone?: "default" | "danger"; children: ReactNode }) {
  return (
    <li className="not-last:border-b not-last:border-divider">
      <Link
        href={href}
        className={cx(
          ROW,
          "text-start text-body transition-[background-color] duration-(--q-duration-fast) hover:bg-selection active:bg-selection focus-visible:outline-offset-[-2px]",
          tone === "danger" ? "text-error-ink" : "text-ink active:text-primary-deep",
        )}
      >
        <span>{children}</span>
        <span aria-hidden="true" className="flex shrink-0 rotate-180 text-ink-secondary">
          <Icon name="back" size="md" />
        </span>
      </Link>
    </li>
  );
}
