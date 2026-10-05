"use client";

import type { ReactNode } from "react";
import { Brand } from "./Brand";
import { SideRail, TabBar } from "./MainNav";
import { SkipLink } from "./SkipLink";
import { TopBar } from "./TopBar";
import { WakeUpStatus } from "./WakeUpStatus";
import { useRouteFocus } from "./use-page-chrome";

// Signed-in shell (UI-design 2.1): bottom tab bar below 1024 px, start-edge rail from 1024 px.
// Both navs are in the DOM and CSS shows one, so the focus order matches the visual order at every width.
export function AppShell({ children }: { children: ReactNode }) {
  useRouteFocus();
  return (
    <div className="flex min-h-dvh flex-col rail:flex-row">
      <SkipLink />
      <SideRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar below="rail">
          <Brand href="/today" />
        </TopBar>
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-column flex-1 px-page py-q24 rail:py-q40"
        >
          <WakeUpStatus />
          {children}
        </main>
      </div>
      <TabBar />
    </div>
  );
}
