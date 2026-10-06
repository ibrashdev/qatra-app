"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/i18n/LocaleProvider";
import type { TabId } from "@/i18n/messages";
import { cx } from "@/lib/cx";
import { Brand } from "./Brand";
import { Icon } from "./Icon";

// The five destinations, in DOM order: today is first, at the start edge in both directions. The lessons tab (D92, owner approval of 5 October 2026) sits
// second: it is read-only text of the learner's own plan, with no questions and no games.
export const TAB_ITEMS: readonly { id: TabId; href: string }[] = [
  { id: "today", href: "/today" },
  { id: "lessons", href: "/lessons" },
  { id: "games", href: "/games" },
  { id: "progress", href: "/progress" },
  { id: "settings", href: "/settings" },
];

// S-20 (the result of a session) belongs to the progress tab. S-19 (/session/<id>) is a focus flow and matches no tab.
const SESSION_RESULT_PATH = /^\/session\/[^/]+\/result\/?$/;

// S-12 (/plan) and S-13 (/plan/revise) are children of the today tab (UI-design 2.1). S-34 (/plan/chat/<id>) is a focus flow and matches no tab.
const TODAY_CHILD_PATH = /^\/plan(?:\/revise)?\/?$/;

// The content manager screens (AD-01 to AD-06, D91) are reached from settings and keep the settings tab active.
const ADMIN_PATH = /^\/admin(?:\/|$)/;

function isActive(pathname: string | null, href: string): boolean {
  if (href === "/settings" && pathname !== null && ADMIN_PATH.test(pathname)) return true;
  if (href === "/progress" && pathname !== null && SESSION_RESULT_PATH.test(pathname)) return true;
  if (href === "/today" && pathname !== null && TODAY_CHILD_PATH.test(pathname)) return true;
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
}

// Bottom tab bar below 1024 px (UA-03, UI-tokens 6.6): a 24 px icon above the label. Five tabs share 320 px, 64 px each, so the label has no side padding
// ("Progress" is about 57 px wide at the caption size and would otherwise break inside the word). The icon is decorative; the label names the link. The active tab is
// marked by a 3 px top bar, a heavier icon stroke, the deep blue and aria-current, not by colour alone.
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
                  "flex h-full min-h-[calc(var(--q-size-tabbar)-1px)] flex-col items-center justify-center gap-q4 border-t-[3px] px-0 py-q4 text-center text-caption [overflow-wrap:anywhere] transition-[color,background-color,border-color] duration-(--q-duration-fast) hover:bg-selection focus-visible:outline-offset-[-2px]",
                  active ? "border-primary text-primary-deep" : "border-transparent text-ink-secondary",
                )}
              >
                <Icon name={id} size="lg" active={active} />
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
