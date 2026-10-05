"use client";

import { use } from "react";
import { PlanReviseScreen } from "@/components/plan-revise/PlanReviseScreen";

// S-13 Plan revision (Batch 2, package F7). `searchParams` is a promise in this Next.js version, read with `use` in a client page.
// `?form=1` opens the structured form at once: the link under S-34's G-35 notice may carry it (UI-screens S-13 "Revealing the form").
export default function PlanRevisePage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { form } = use(searchParams);
  return <PlanReviseScreen revealForm={form === "1"} />;
}
