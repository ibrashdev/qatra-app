import { TermsLoading } from "@/components/terms/TermsLoading";

// The view shown while the route of S-03 is still loading (S-02 and S-06 load it ahead of the press, so it is rarely seen).
export default function Loading() {
  return <TermsLoading />;
}
