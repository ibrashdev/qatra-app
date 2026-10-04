"use client";

import type { ReactNode } from "react";
import { Brand } from "./Brand";
import { LanguageSwitch } from "./LanguageSwitch";
import { SkipLink } from "./SkipLink";
import { TopBar } from "./TopBar";
import { WakeUpStatus } from "./WakeUpStatus";
import { useRouteFocus } from "./use-page-chrome";

// Visitor shell (UI-design 2.1): the language switch in the header, no tab bar, no rail. Each public screen renders its own,
// because the header and the place of the wake-up banner differ per screen (UI-screens P-02, P-04).
// logo: the product lockup as a link at the start edge; a screen that carries its own lockup in the page turns it off.
// wakeUp: the line at the top of the page; a form shows it above its submit button instead and turns this off.
export function PublicShell({ children, logo = true, wakeUp = true }: { children: ReactNode; logo?: boolean; wakeUp?: boolean }) {
  useRouteFocus();
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <TopBar>
        {logo ? <Brand href="/" /> : null}
        <div className="ms-auto">
          <LanguageSwitch />
        </div>
      </TopBar>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column flex-1 px-page py-q24 tablet:py-q32">
        {wakeUp ? <WakeUpStatus /> : null}
        {children}
      </main>
    </div>
  );
}
