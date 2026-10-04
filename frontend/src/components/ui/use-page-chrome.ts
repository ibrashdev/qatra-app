"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

// After a route change focus moves to the page heading (UI-tokens 7); the first load does not steal focus.
export function useRouteFocus(): void {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (previous.current !== null && previous.current !== pathname) {
      const target = document.querySelector<HTMLElement>("[data-page-heading]") ?? document.querySelector<HTMLElement>("main");
      target?.focus();
    }
    previous.current = pathname;
  }, [pathname]);
}
