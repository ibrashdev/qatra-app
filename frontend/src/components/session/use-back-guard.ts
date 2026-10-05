"use client";

import { useEffect, useRef } from "react";

// UA-09: on entering the session the route pushes one history entry of its own. Back, the iOS edge swipe and the Android back gesture use that entry
// up, so the page stays and asks (the pause sheet) instead of leaving; asking pushes the entry again. The entry holds a marker and nothing else.
// The capture phase keeps the pop away from the router, so it never re-renders the route for it.
const SENTINEL = "qatraSessionGuard";

function isSentinelEntry(): boolean {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null && SENTINEL in state;
}

export function useBackGuard({ enabled, onAttempt }: { enabled: boolean; onAttempt: () => void }): void {
  const attempt = useRef(onAttempt);
  useEffect(() => {
    attempt.current = onAttempt;
  });

  useEffect(() => {
    if (!enabled) return;
    let armed = false;
    // Development runs this effect twice: the second run finds the entry already there.
    if (!isSentinelEntry()) window.history.pushState({ [SENTINEL]: true }, "");
    armed = true;

    function onPopState(event: PopStateEvent) {
      // A jump within the page (the skip link) is reported with no state: it leaves nothing to ask about.
      if (event.state === null) return;
      // Landed on a guard entry (Forward): the guard is on top again.
      if (isSentinelEntry()) {
        armed = true;
        return;
      }
      if (!armed) return;
      armed = false;
      event.stopImmediatePropagation();
      attempt.current();
      window.history.pushState({ [SENTINEL]: true }, "");
      armed = true;
    }

    window.addEventListener("popstate", onPopState, true);
    return () => window.removeEventListener("popstate", onPopState, true);
  }, [enabled]);
}
