import { PlaceholderRoute } from "@/components/ui/PlaceholderRoute";

// Placeholder only: the re-consent gate (S-06) comes later in Batch 1. The login screen sends a visitor here when E04 asks for consent.
export default function ConsentPage() {
  return <PlaceholderRoute screen="consent" />;
}
