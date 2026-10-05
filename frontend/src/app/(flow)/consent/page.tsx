import { ConsentScreen } from "@/components/consent/ConsentScreen";

// S-06. A focus screen with its own header (the droplet and the product name only), reached by replace navigation after a login that asks for
// consent, or after any call answered with `terms_required`. It leaves by consent or by logout.
export default function ConsentPage() {
  return <ConsentScreen />;
}
