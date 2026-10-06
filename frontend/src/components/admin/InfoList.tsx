import type { ReactNode } from "react";

// A definition list on one bordered surface: the term above its value on a phone, side by side from 768 px. Values wrap anywhere, so a long key or
// hash never widens the page.
export function InfoList({ children }: { children: ReactNode }) {
  return <dl className="rounded-md border border-divider bg-surface px-q16">{children}</dl>;
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-q4 py-q12 not-last:border-b not-last:border-divider tablet:flex-row tablet:gap-q16">
      <dt className="shrink-0 text-small text-ink-secondary tablet:w-44">{label}</dt>
      <dd className="min-w-0 flex-1 text-body-compact text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

// One labelled value inside a card of a list: the label and the value on one line when they fit, the value wrapping anywhere.
export function DetailLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-q8">
      <dt className="text-ink-secondary">{label}:</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

// Text from the server or the database: it may be in either script and is isolated, so its direction never reorders the sentence around it.
export function Mixed({ children }: { children: ReactNode }) {
  return <bdi dir="auto">{children}</bdi>;
}

// An identifier, a hash or a link: always left to right.
export function Technical({ children }: { children: ReactNode }) {
  return <bdi dir="ltr">{children}</bdi>;
}
