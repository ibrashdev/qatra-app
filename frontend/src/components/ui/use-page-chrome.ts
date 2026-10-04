"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

// Kept at module level: a shell that mounts after a client navigation (each public screen renders its own) still knows where the visitor came from.
let lastPathname: string | null = null;

// After a route change focus moves to the page heading (UI-tokens 7); the first load does not steal focus.
export function useRouteFocus(): void {
  const pathname = usePathname();
  useEffect(() => {
    if (lastPathname !== null && lastPathname !== pathname) {
      const target = document.querySelector<HTMLElement>("[data-page-heading]") ?? document.querySelector<HTMLElement>("main");
      target?.focus();
    }
    lastPathname = pathname;
  }, [pathname]);
}

export function resetRouteFocusForTests(): void {
  lastPathname = null;
}
