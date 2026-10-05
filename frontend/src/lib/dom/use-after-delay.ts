"use client";

import { useEffect, useState } from "react";

// False at first, true once `ms` have passed since the component mounted. A skeleton uses it, so a fast load never flashes one (UI-tokens 6.14: 300 ms).
export function useAfterDelay(ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return elapsed;
}
