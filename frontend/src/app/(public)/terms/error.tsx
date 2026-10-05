"use client";

import { TermsError } from "@/components/terms/TermsError";

// `retry` fetches the route again and renders it; `reset` would only clear the error and render what has already failed (Next docs, error.js).
export default function TermsRouteError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <TermsError retry={retry} />;
}
