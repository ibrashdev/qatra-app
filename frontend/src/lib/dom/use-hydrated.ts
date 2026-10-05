"use client";

import { useSyncExternalStore } from "react";

const subscribe = (): (() => void) => () => undefined;

// False while the server renders and while the browser hydrates that markup, true from the render after it, when the interface language
// (read from the browser, not from the server) has been applied to the text. On a client navigation there is no hydration, so it is true at once.
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
