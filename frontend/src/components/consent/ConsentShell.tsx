"use client";

import type { ReactNode } from "react";
import { BrandMark } from "@/components/ui/BrandMark";
import { PageTitle } from "@/components/ui/PageTitle";
import { SkipLink } from "@/components/ui/SkipLink";
import { TopBar } from "@/components/ui/TopBar";
import { useRouteFocus } from "@/components/ui/use-page-chrome";
import { useLocale } from "@/i18n/LocaleProvider";

// The focus screen of UI-design 2.1 for S-06: the header holds the droplet and the product name and nothing else (not a link, no back control, no
// language switch: the profile language rules), and there is no tab bar. The only ways out are consent and logout, so there is no way back.
// The wake-up line is not at the top: the form shows it above its button, and the load failure shows it in place of the form.
export function ConsentShell({ children }: { children: ReactNode }) {
  const { messages } = useLocale();
  useRouteFocus();
  return (
    <div className="flex min-h-dvh flex-col">
      <PageTitle screenName={messages.screens.consent} />
      <SkipLink />
      <TopBar>
        <BrandMark />
      </TopBar>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-column flex-1 px-page py-q24 tablet:py-q32">
        <div className="mx-auto w-full max-w-form">{children}</div>
      </main>
    </div>
  );
}
