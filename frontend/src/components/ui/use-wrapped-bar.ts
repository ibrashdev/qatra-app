"use client";

import { useEffect, useState } from "react";

// A top bar is one row when its content fits the row's own minimum height (56 px at 100 % text, growing with the text size). Taller means
// it has wrapped: its controls went to a second row, or its title to a third line. A sticky bar like that takes much of a small window
// for good (200 % text on 320 px: 305 px of 568 px), so the header turns static while it is wrapped (WCAG 1.4.4, 1.4.10, 2.4.11).
//
// The limit is one row plus half a rem: the room that the page's scroll padding keeps clear (globals.css), so a sticky bar never hides a
// focused control. It also lets a title run to two lines (UI-tokens 6.6), which the literal one row would not.
//
// `barRef` goes on the <header>, whose first child is the row that carries the minimum height; the header shows `wrapped` as data-wrapped.
export function useWrappedBar(): { barRef: (element: HTMLElement | null) => void; wrapped: boolean } {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [wrapped, setWrapped] = useState(false);

  useEffect(() => {
    // Without the observer (an old browser, a test environment) the bar stays sticky, as it was.
    if (bar === null || typeof ResizeObserver === "undefined") return;
    // It reports once when it starts and again whenever the bar's size changes: window width, text size (the bar is in rem), language, title.
    const observer = new ResizeObserver(() => {
      const row = bar.firstElementChild;
      const oneRow = row === null ? Number.NaN : Number.parseFloat(getComputedStyle(row).minHeight);
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      // Below the safe area at the top of the screen, which the page's scroll padding counts on its own.
      const height = bar.getBoundingClientRect().height - Number.parseFloat(getComputedStyle(bar).paddingTop);
      // A size that cannot be read is NaN, and nothing is taller than NaN: the bar then stays sticky.
      setWrapped(height > oneRow + rem / 2);
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [bar]);

  return { barRef: setBar, wrapped };
}
