"use client";

import type { ReactNode } from "react";
import { BrandMark } from "@/components/ui/BrandMark";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { PageTitle } from "@/components/ui/PageTitle";
import { SkipLink } from "@/components/ui/SkipLink";
import { TopBar } from "@/components/ui/TopBar";

// The minimal shell of S-31. The route sits under the root layout only (not the signed-in shell), and nothing inside it may be a <Link>: a client navigation
// asks the server for a payload, which fails offline. The lockup is therefore plain text, not a link, and the language switch is the only control in the bar.
export function OfflineChrome({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <PageTitle screenName={title} />
      <SkipLink />
      <TopBar>
        <span className="inline-flex min-h-target items-center">
          <BrandMark />
        </span>
        <div className="ms-auto">
          <LanguageSwitch />
        </div>
      </TopBar>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column flex-1 px-page py-q24 tablet:py-q32">
        <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
          {title}
        </h1>
        <div className="mt-q16 flex flex-col gap-q16">{children}</div>
      </main>
    </div>
  );
}
