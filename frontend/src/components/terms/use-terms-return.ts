"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { BackTarget } from "@/components/ui/BackControl";
import { useLocale } from "@/i18n/LocaleProvider";
import { routeBefore } from "@/lib/nav/route-history";
import { termsOpener, type TermsOpener } from "@/lib/nav/terms-opener";

export interface TermsReturn {
  opener: TermsOpener;
  back: BackTarget; // the control in the header (c1)
  goBack: () => void; // the button after the text (c6)
}

// S-03 "Exit": back to the screen that opened it, with its state kept, or to / when it was opened directly.
// "Back" is the browser's own step back, so the register form returns as it was left and the history does not grow.
export function useTermsReturn(): TermsReturn {
  const pathname = usePathname();
  const router = useRouter();
  const { messages } = useLocale();
  // Fixed when the screen opens, so the answer cannot change once the tracker has noted this very route.
  const [opener] = useState(() => termsOpener(routeBefore(pathname)));
  const destination = messages.terms.destinations[opener];

  if (opener === "home") {
    return { opener, back: { destination, href: "/" }, goBack: () => router.push("/") };
  }
  const goBack = () => router.back();
  return { opener, back: { destination, onClick: goBack }, goBack };
}
