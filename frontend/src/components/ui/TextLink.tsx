import Link from "next/link";
import type { ReactNode } from "react";

// A text link on a line of its own: underlined, in the link colour, 44 px high so the target is reachable (UI-tokens 6.1, 2.5.8).
// prefetch loads the whole route ahead of the press (a production build only); onClick runs before the navigation.
export function TextLink({ href, children, prefetch, onClick }: { href: string; children: ReactNode; prefetch?: boolean; onClick?: () => void }) {
  return (
    <Link href={href} prefetch={prefetch} onClick={onClick} className="inline-flex min-h-target items-center rounded-sm text-body text-link underline underline-offset-4">
      {children}
    </Link>
  );
}
