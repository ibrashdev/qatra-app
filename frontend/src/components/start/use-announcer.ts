"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// One polite region for everything S-08 says to a screen reader (a list appeared, the count, the sentence, a chip removed). The count and the
// sentence are debounced (UI-tokens 6.26: 500 ms), so a select-all is announced once and not once per row.
export function useAnnouncer(): {
  message: string;
  say: (text: string) => void;
  sayAfter: (text: string, delayMs: number) => void;
  cancelPending: () => void;
} {
  const [message, setMessage] = useState("");
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const cancelPending = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const say = useCallback((text: string) => setMessage(text), []);

  const sayAfter = useCallback((text: string, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setMessage(text);
    }, delayMs);
    timers.current.add(timer);
  }, []);

  useEffect(() => cancelPending, [cancelPending]);

  return { message, say, sayAfter, cancelPending };
}
