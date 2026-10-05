"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { cx } from "@/lib/cx";

function subscribeScroll(onChange: () => void): () => void {
  window.addEventListener("scroll", onChange, { passive: true });
  return () => window.removeEventListener("scroll", onChange);
}

const isScrolled = (): boolean => window.scrollY > 0;
const isScrolledOnServer = (): boolean => false;

// Top app bar (UI-tokens 6.6): no shadow, and a 1 px divider only once the content scrolls under it.
export function TopBar({ children, className }: { children: ReactNode; className?: string }) {
  const scrolled = useSyncExternalStore(subscribeScroll, isScrolled, isScrolledOnServer);
  return (
    <header
      data-scrolled={scrolled}
      className={cx(
        "sticky top-0 z-(--q-z-sticky) border-b border-transparent bg-page pt-[env(safe-area-inset-top)] data-[scrolled=true]:border-divider",
        className,
      )}
    >
      {/* The controls wrap rather than run off the page when the text is enlarged (their sizes are in rem). */}
      <div className="flex min-h-appbar flex-wrap items-center justify-between gap-q12 px-page">{children}</div>
    </header>
  );
}
