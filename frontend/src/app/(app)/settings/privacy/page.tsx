import { PrivacyScreen } from "@/components/privacy/PrivacyScreen";

// S-26 Privacy and data (Batch 4, package F11): the S-03 text in the signed-in shell. Without a session the screen hands over to /terms (guard 13).
export default function PrivacyPage() {
  return <PrivacyScreen />;
}
