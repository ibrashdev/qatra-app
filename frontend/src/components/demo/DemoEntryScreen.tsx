"use client";

import { RegisterForm } from "@/components/auth/RegisterForm";
import { PublicShell } from "@/components/ui/PublicShell";
import { demoMessages } from "@/i18n/demo-messages";
import { useLocale } from "@/i18n/LocaleProvider";

// S-28 in the public shell: the account form of S-02 for a demo account (E26). The back control names S-07, the public catalog, which is the page the
// committee link is shared from. The name is in the interface language, so this is a client component.
export function DemoEntryScreen() {
  const { locale } = useLocale();
  return (
    <PublicShell back={{ destination: demoMessages(locale).entry.backDestination, href: "/" }} logo={false} wakeUp={false}>
      <RegisterForm variant="demo" />
    </PublicShell>
  );
}
