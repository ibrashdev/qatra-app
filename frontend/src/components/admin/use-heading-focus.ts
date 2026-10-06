"use client";

import { useCallback, useEffect, useState } from "react";

// Puts the focus on the page heading once the screen has settled. The button that opened a dialog may be gone when the dialog closes (a withdrawn
// edition has no Withdraw button, a deleted row has no Delete button), and focus must not fall to the page. The focus moves in an effect, after the
// commit that closed the dialog and released the page behind it, because a heading behind an open modal dialog cannot take focus.
export function useHeadingFocus(): () => void {
  const [requests, setRequests] = useState(0);
  useEffect(() => {
    if (requests > 0) document.querySelector<HTMLElement>("[data-page-heading]")?.focus();
  }, [requests]);
  return useCallback(() => setRequests((value) => value + 1), []);
}
