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

// Scrolls to the anchor of the address and focuses it. False when the address names none, or one that is not in the page (yet).
function focusAnchor(): boolean {
  const anchor = anchorTarget();
  if (anchor === null) return false;
  anchor.scrollIntoView({ block: "start" });
  anchor.focus({ preventScroll: true });
  return true;
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
    if (focusAnchor()) return;
    if (changed) {
      const target = document.querySelector<HTMLElement>("[data-page-heading]") ?? document.querySelector<HTMLElement>("main");
      target?.focus();
    }
  }, [pathname, enabled, hydrated]);
}

// For a screen that arrives after its route changed, inside a shell that stays across routes (the app shell, whose page region shows a loading or an
// error view first). The shell has already moved focus to the page heading, which such a screen keeps in a frame of its own that does not unmount
// (so the focus is never on something that goes), and two things are left for the screen itself once its content is there: the anchor of the
// address, which was not in the page until now, and the focus that fell to the page when a retry button went. The first load does nothing here
// (useRouteFocus leaves it alone unless the address names an anchor).
export function useArrivalFocus(): void {
  useEffect(() => {
    if (lastPathname === null) return;
    if (focusAnchor()) return;
    const active = document.activeElement;
    if (active === null || active === document.body) document.querySelector<HTMLElement>("[data-page-heading]")?.focus();
  }, []);
}

export function resetRouteFocusForTests(): void {
  lastPathname = null;
}
