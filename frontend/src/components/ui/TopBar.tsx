"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { useWrappedBar } from "./use-wrapped-bar";

function subscribeScroll(onChange: () => void): () => void {
  window.addEventListener("scroll", onChange, { passive: true });
  return () => window.removeEventListener("scroll", onChange);
}

const isScrolled = (): boolean => window.scrollY > 0;
const isScrolledOnServer = (): boolean => false;

// Top app bar (UI-tokens 6.6): no shadow, and a 1 px divider only once the content scrolls under it.
// It is sticky while it is one row, and static once it has wrapped (use-wrapped-bar.ts). Static or sticky, its box keeps its place in the
// page flow, so nothing moves when it changes; no transition is involved, so reduced motion has nothing to switch off.
export function TopBar({ children, className }: { children: ReactNode; className?: string }) {
  const scrolled = useSyncExternalStore(subscribeScroll, isScrolled, isScrolledOnServer);
  const { barRef, wrapped } = useWrappedBar();
  return (
    <header
      ref={barRef}
      // Only a sticky bar has content scrolling under it, so only a sticky bar shows the divider.
      data-scrolled={scrolled && !wrapped}
      data-wrapped={wrapped}
      className={cx(
        "sticky top-0 z-(--q-z-sticky) border-b border-transparent bg-page pt-[env(safe-area-inset-top)] data-[scrolled=true]:border-divider data-[wrapped=true]:static",
        className,
      )}
    >
      {/* The controls wrap rather than run off the page when the text is enlarged (their sizes are in rem). */}
      <div className="flex min-h-appbar flex-wrap items-center justify-between gap-q12 px-page">{children}</div>
    </header>
  );
}
