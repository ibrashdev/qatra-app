import { OfflineShell } from "@/components/pwa/OfflineShell";

// S-31 (the PWA start_url). Public and prerendered: the HTML holds no account data, and the service worker serves it from its cache when there is no network.
// Everything personal is read from IndexedDB by the client component after hydration; no <Link> or router transition lives inside it.
export default function OfflinePage() {
  return <OfflineShell />;
}
