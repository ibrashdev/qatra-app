"use client";

import { TermsUnavailable } from "@/components/terms/TermsError";

// The text could not load: the frame stays, an error banner says so and focus goes to its retry button. `retry` fetches the route again and renders it;
// `reset` would only clear the error and render what has already failed (Next docs, error.js).
export default function PrivacyRouteError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <TermsUnavailable retry={retry} />;
}
