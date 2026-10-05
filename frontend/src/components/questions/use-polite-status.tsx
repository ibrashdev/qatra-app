"use client";

import { useCallback, useRef, useState, type ReactElement } from "react";

// One visually hidden polite region for the small announcements of a piece (a word placed, an option removed, a first letter shown).
// The feedback block is a second, separate region (UI-screens S-15 5), so the two never overlap.
export function usePoliteStatus(): { announce: (text: string) => void; region: ReactElement } {
  const [message, setMessage] = useState("");
  const flip = useRef(false);

  // Announcing the same sentence twice in a row needs a changed text node, so every other call carries an invisible suffix.
  const announce = useCallback((text: string) => {
    flip.current = !flip.current;
    setMessage(flip.current ? text : `${text}​`);
  }, []);

  const region = (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
  return { announce, region };
}
