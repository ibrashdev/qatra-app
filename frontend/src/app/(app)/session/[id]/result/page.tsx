"use client";

import { use } from "react";
import { ResultScreen } from "@/components/result/ResultScreen";

// S-20 Session result (UI-design route /session/[id]/result, Batch 4, package F10). `params` is a promise in this Next.js version, read with `use` in a client page.
export default function SessionResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ResultScreen sessionId={id} />;
}
