"use client";

import { use } from "react";
import { SessionScreen } from "@/components/session/SessionScreen";

// S-19 (UI-screens Batch 4, route /session/[id]). `params` is a promise in this Next.js version, read with `use` in a client page, as S-34 does.
export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <SessionScreen routeId={id} />;
}
