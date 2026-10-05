import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

// A navigation that looks like a button (UI-tokens 6.1 recipes): the Button of the kit renders a <button>, and these destinations are links.
const VARIANTS = {
  primary: "bg-primary text-on-primary hover:bg-primary-deep active:bg-primary-pressed",
  secondary: "border border-edge bg-surface text-primary-deep hover:border-edge-selected hover:bg-selection active:border-primary-deep active:bg-selection",
} as const;

export function LinkButton({ href, variant = "primary", fullWidth = false, children }: { href: string; variant?: keyof typeof VARIANTS; fullWidth?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex min-h-button min-w-22 items-center justify-center rounded-sm px-q24 text-button transition-[color,background-color,border-color] duration-(--q-duration-fast)",
        VARIANTS[variant],
        fullWidth && "w-full",
      )}
    >
      {children}
    </Link>
  );
}
