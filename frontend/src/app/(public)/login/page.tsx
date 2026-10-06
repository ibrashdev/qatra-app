import { LoginForm } from "@/components/auth/LoginForm";
import { PublicShell } from "@/components/ui/PublicShell";

// S-01. No logo in the header (the page carries the lockup) and no wake-up line at the top (the form shows it above its button).
// The demo link (option C) is on for the page.
export default function LoginPage() {
  return (
    <PublicShell logo={false} wakeUp={false}>
      <LoginForm demoLink />
    </PublicShell>
  );
}
