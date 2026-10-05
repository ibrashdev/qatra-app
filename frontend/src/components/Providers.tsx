"use client";

import type { ReactNode } from "react";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { RouteTracker } from "./RouteTracker";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider>
      <ApiRuntimeProvider>
        <RouteTracker />
        {children}
      </ApiRuntimeProvider>
    </LocaleProvider>
  );
}
