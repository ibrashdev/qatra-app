"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/i18n/LocaleProvider";
import type { TabId } from "@/i18n/messages";
import { cx } from "@/lib/cx";
import { Brand } from "./Brand";

// The four destinations of UX.md, in DOM order: today is first, at the start edge in both directions.
export const TAB_ITEMS: readonly { id: TabId; href: string }[] = [
  { id: "today", href: "/today" },
  { id: "games", href: "/games" },
  { id: "progress", href: "/progress" },
  { id: "settings", href: "/settings" },
];

// S-20 (the result of a session) belongs to the progress tab. S-19 (/session/<id>) is a focus flow and matches no tab.
const SESSION_RESULT_PATH = /^\/session\/[^/]+\/result\/?$/;

function isActive(pathname: string | null, href: string): boolean {
  if (href === "/progress" && pathname !== null && SESSION_RESULT_PATH.test(pathname)) return true;
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
}

// Bottom tab bar below 1024 px (UA-03). Text only: the active tab is marked by a 3 px top bar and aria-current, not by colour alone.
export function TabBar() {
  const { messages } = useLocale();
  const pathname = usePathname();
  return (
    <nav
      aria-label={messages.mainNavigationLabel}
      className="sticky bottom-0 z-(--q-z-sticky) border-t border-divider bg-surface pb-[env(safe-area-inset-bottom)] rail:hidden"
    >
      <ul className="flex">
        {TAB_ITEMS.map(({ id, href }) => {
          const active = isActive(pathname, href);
          return (
            <li key={id} className="min-w-0 flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex h-full min-h-[calc(var(--q-size-tabbar)-1px)] items-center justify-center border-t-[3px] px-q4 py-q8 text-center text-caption [overflow-wrap:anywhere] transition-[color,background-color,border-color] duration-(--q-duration-fast) hover:bg-selection focus-visible:outline-offset-[-2px]",
                  active ? "border-primary text-primary-deep" : "border-transparent text-ink-secondary",
                )}
              >
                {messages.tabs[id]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// Side rail at the start edge from 1024 px: the same destinations, with the product name on top.
export function SideRail() {
  const { messages } = useLocale();
  const pathname = usePathname();
  return (
    <nav
      aria-label={messages.mainNavigationLabel}
      className="sticky top-0 hidden h-dvh w-rail shrink-0 flex-col gap-q24 border-e border-divider bg-surface px-q8 py-q24 rail:flex"
    >
      <div className="px-q8">
        <Brand href="/today" />
      </div>
      <ul className="flex flex-col gap-q4">
        {TAB_ITEMS.map(({ id, href }) => {
          const active = isActive(pathname, href);
          return (
            <li key={id}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex min-h-button items-center border-s-[3px] px-q16 text-body transition-[color,background-color,border-color] duration-(--q-duration-fast) hover:bg-selection",
                  active ? "border-primary bg-selection font-semibold text-primary-deep" : "border-transparent text-ink",
                )}
              >
                {messages.tabs[id]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
