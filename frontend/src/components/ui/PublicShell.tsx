"use client";

import type { ReactNode } from "react";
import { Brand } from "./Brand";
import { LanguageSwitch } from "./LanguageSwitch";
import { SkipLink } from "./SkipLink";
import { TopBar } from "./TopBar";
import { WakeUpStatus } from "./WakeUpStatus";
import { useRouteFocus } from "./use-page-chrome";

// Visitor shell (UI-design 2.1): the name and the language switch in the header, no tab bar, no rail.
export function PublicShell({ children }: { children: ReactNode }) {
  useRouteFocus();
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <TopBar>
        <Brand href="/" />
        <LanguageSwitch />
      </TopBar>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column flex-1 px-page py-q24 tablet:py-q32">
        <WakeUpStatus />
        {children}
      </main>
    </div>
  );
}
