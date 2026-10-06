"use client";

import type { ReactNode } from "react";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { OnlineJournalSync } from "./pwa/OnlineJournalSync";
import { RouteTracker } from "./RouteTracker";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider>
      <ApiRuntimeProvider>
        <RouteTracker />
        <OnlineJournalSync />
        {children}
      </ApiRuntimeProvider>
    </LocaleProvider>
  );
}
