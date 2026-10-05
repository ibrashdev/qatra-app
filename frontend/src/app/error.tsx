"use client";

import { ErrorView } from "@/components/ui/ErrorView";

// `retry` fetches the route again and renders it; `reset` would only clear the error and render what has already failed
// (Next 16 docs, error.js: `retry` is stable from 16.3.0 and is the one to use unless the content must not be fetched again).
export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView retry={retry} />;
}
