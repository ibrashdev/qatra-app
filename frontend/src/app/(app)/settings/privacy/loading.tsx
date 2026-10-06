import { TermsLoadingRegion } from "@/components/terms/TermsLoading";

// The view shown while the text of S-26 is still loading, under the frame of the layout: skeleton lines after 300 ms, and the wait announced.
export default function Loading() {
  return <TermsLoadingRegion />;
}
