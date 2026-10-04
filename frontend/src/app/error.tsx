"use client";

import { ErrorView } from "@/components/ui/ErrorView";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView reset={reset} />;
}
