import Link from "next/link";
import type { ReactNode } from "react";

// A text link on a line of its own: underlined, in the link colour, 44 px high so the target is reachable (UI-tokens 6.1, 2.5.8).
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex min-h-target items-center rounded-sm text-body text-link underline underline-offset-4">
      {children}
    </Link>
  );
}
