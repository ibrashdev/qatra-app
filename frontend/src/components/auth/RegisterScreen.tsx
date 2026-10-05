"use client";

import { PublicShell } from "@/components/ui/PublicShell";
import { useLocale } from "@/i18n/LocaleProvider";
import { RegisterForm } from "./RegisterForm";

// S-02 in the public shell: the back control names S-07 (the public catalog) and goes to /login until S-07 ships in Batch 2.
// The name is in the interface language, so this is a client component.
export function RegisterScreen() {
  const { messages } = useLocale();
  return (
    <PublicShell back={{ destination: messages.auth.register.backDestination, href: "/login" }} logo={false} wakeUp={false}>
      <RegisterForm />
    </PublicShell>
  );
}
