"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

// S-04 asks before the learner leaves with the confirmation box unchecked (UI-screens S-04 section 3, leave dialog). The App Router has no
// hook for a route change, so the guard watches the ways out that the page itself can see:
//   Back or an edge swipe: a history entry of its own sits on top of the screen's entry. Back uses it up, the guard asks, and "stay" adds another.
//   A click on a link inside the app: caught before the router sees it. This screen has none yet; the guard is there for the day it gains one.
//   Closing the tab, reloading, or leaving the app by a link: the browser's own prompt (beforeunload).
// Navigation made by other code cannot be seen. The entry holds a marker and nothing else: never the code.
const SENTINEL = "qatraRecoveryCodeGuard";

// A pop that the guard asked for is reported by the browser a moment later; after this long it is taken as lost.
const SETTLE_TIMEOUT_MS = 1_000;

export interface LeaveGuard {
  // After "stay": the Back press used the guard's entry up, so it adds another.
  rearm: () => void;
  // Before the screen leaves by itself: takes the guard's entry out of the history, so the next screen replaces the screen's own entry and
  // back never returns here. Resolves once the browser has done it.
  release: () => Promise<void>;
}

function isSentinelEntry(): boolean {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null && SENTINEL in state;
}

function pushSentinelEntry(): void {
  window.history.pushState({ [SENTINEL]: true }, "");
}

// `active` is true while the box is unchecked: only then does a way out ask. `onAttempt` opens the dialog.
export function useRecoveryCodeLeaveGuard({ active, onAttempt }: { active: boolean; onAttempt: () => void }): LeaveGuard {
  const activeRef = useRef(active);
  const attemptRef = useRef(onAttempt);
  // True while the guard's own entry is the top one.
  const armed = useRef(false);
  // Pops the guard asked for that the browser has not reported yet, and the callers waiting for them.
  const pending = useRef(0);
  const waiting = useRef<Array<() => void>>([]);
  // The learner pressed Back with the box checked: the guard has used its entry up and lets the next pop through.
  const steppedAside = useRef(false);

  useEffect(() => {
    activeRef.current = active;
    attemptRef.current = onAttempt;
  });

  const settle = useCallback(() => {
    const callers = waiting.current;
    waiting.current = [];
    for (const resolve of callers) resolve();
  }, []);

  useEffect(() => {
    // Development runs this effect twice: the second run finds the entry already there.
    if (!armed.current) {
      pushSentinelEntry();
      armed.current = true;
    }

    // In the capture phase, so a pop that belongs to the guard never reaches the router.
    function onPopState(event: PopStateEvent) {
      if (steppedAside.current) return;
      if (pending.current > 0) {
        event.stopImmediatePropagation();
        // Still above the screen's own entry (a jump within the page, then the guard's entry): those come out too.
        if (event.state === null || isSentinelEntry()) {
          window.history.back();
          return;
        }
        pending.current -= 1;
        settle();
        return;
      }
      // A jump within the page (the skip link) is reported too, with no state: it leaves nothing to ask about.
      if (event.state === null) return;
      // Landed on a guard entry (Back from an in-page jump, or Forward): the guard is still on top.
      if (isSentinelEntry()) {
        armed.current = true;
        return;
      }
      if (!armed.current) return;
      // Back used the guard's entry up and the screen's own entry is current again.
      armed.current = false;
      event.stopImmediatePropagation();
      if (activeRef.current) {
        attemptRef.current();
      } else {
        // Nothing to ask: the Back press goes on to the page before.
        steppedAside.current = true;
        window.history.back();
      }
    }

    function onClick(event: MouseEvent) {
      if (!activeRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      // Links out of the app and files are the browser's business, and beforeunload covers them.
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== window.location.origin) return;
      // A jump within this page (the skip link) leaves nothing behind.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      attemptRef.current();
    }

    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!activeRef.current) return;
      event.preventDefault();
      // Older browsers ask for the prompt through the return value; the text is ignored and the browser's own wording is shown.
      event.returnValue = "";
    }

    window.addEventListener("popstate", onPopState, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("popstate", onPopState, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [settle]);

  const rearm = useCallback(() => {
    if (armed.current) return;
    pushSentinelEntry();
    armed.current = true;
  }, []);

  const release = useCallback((): Promise<void> => {
    if (!armed.current) return Promise.resolve();
    armed.current = false;
    pending.current += 1;
    return new Promise<void>((resolve) => {
      waiting.current.push(resolve);
      window.setTimeout(() => {
        // The pop was never reported (the browser skipped the entry): stop counting on it.
        if (waiting.current.includes(resolve)) {
          pending.current = Math.max(0, pending.current - 1);
          settle();
        }
      }, SETTLE_TIMEOUT_MS);
      window.history.back();
    });
  }, [settle]);

  return useMemo(() => ({ rearm, release }), [rearm, release]);
}
