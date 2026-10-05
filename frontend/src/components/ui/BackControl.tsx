"use client";

import Link from "next/link";
import { useLocale } from "@/i18n/LocaleProvider";
import { Icon } from "./Icon";

export interface BackTarget {
  destination: string; // where the control goes, named for assistive technology: "Back to {destination}"
  href?: string;
  onClick?: () => void;
}

// UI-tokens 6.1 icon button: 44 by 44, a 24 px glyph in the secondary text colour, the selection fill and the deep blue on hover.
const CLASS_NAME =
  "inline-flex size-target shrink-0 items-center justify-center rounded-sm text-ink-secondary transition-[color,background-color] duration-(--q-duration-fast) hover:bg-selection hover:text-primary-deep";

// The back control of a top bar (UI-screens P-02, P-11): at the start edge, the arrow mirrors in right-to-left, the name says where it goes.
export function BackControl({ destination, href, onClick }: BackTarget) {
  const { messages } = useLocale();
  const name = messages.backTo(destination);
  const arrow = <Icon name="back" size="lg" />;
  return href ? (
    <Link href={href} aria-label={name} className={CLASS_NAME}>
      {arrow}
    </Link>
  ) : (
    <button type="button" aria-label={name} onClick={onClick} className={CLASS_NAME}>
      {arrow}
    </button>
  );
}
