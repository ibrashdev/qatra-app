import { RecoveryCodeScreen } from "@/components/auth/RecoveryCodeScreen";

// S-04. A focus screen with its own header (the droplet and the product name only), reached by replace navigation from the screen
// whose response carried the code. Without the code in memory it returns to that screen's side of the flow (guard 9).
export default function RecoveryCodePage() {
  return <RecoveryCodeScreen />;
}
