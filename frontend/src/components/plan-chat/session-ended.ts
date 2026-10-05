import { raiseLoginArrival } from "@/lib/auth/flash";

// G-03: the session ended. S-01 opens with the session-ended banner and sends the visitor back to `next` after login.
export function redirectToLogin(router: { replace: (href: string) => void }, next: string): void {
  raiseLoginArrival("session_ended");
  router.replace(`/login?next=${encodeURIComponent(next)}`);
}
