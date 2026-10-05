"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useHydrated } from "@/lib/dom/use-hydrated";

// Kept at module level: a shell that mounts after a client navigation (each public screen renders its own) still knows where the visitor came from.
let lastPathname: string | null = null;

// The element a link such as /terms#privacy points at, when it can take focus (a heading with tabindex="-1", UI-screens P-01).
function anchorTarget(): HTMLElement | null {
  const raw = window.location.hash.slice(1);
  if (raw === "") return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const element = document.getElementById(id);
  return element?.hasAttribute("tabindex") ? element : null;
}

// After a route change focus moves to the page heading, or to the heading an anchor names (UI-tokens 7). The first load does not steal
// focus unless the address names an anchor. A loading or error view passes `enabled` false, so it does not use up the route change.
// An anchor is scrolled to as well, and only once the page is settled: the browser's own scroll came before the saved language changed
// the length of the text, and a route that loaded late (its loading view came first) was never scrolled to.
export function useRouteFocus(enabled = true): void {
  const pathname = usePathname();
  const hydrated = useHydrated();
  useEffect(() => {
    if (!enabled || !hydrated) return;
    const changed = lastPathname !== null && lastPathname !== pathname;
    lastPathname = pathname;
    const anchor = anchorTarget();
    if (anchor) {
      anchor.scrollIntoView({ block: "start" });
      anchor.focus({ preventScroll: true });
      return;
    }
    if (changed) {
      const target = document.querySelector<HTMLElement>("[data-page-heading]") ?? document.querySelector<HTMLElement>("main");
      target?.focus();
    }
  }, [pathname, enabled, hydrated]);
}

export function resetRouteFocusForTests(): void {
  lastPathname = null;
}
