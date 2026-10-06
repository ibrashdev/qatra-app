"use client";

import { use } from "react";
import { SectionScreen } from "@/components/admin/SectionScreen";

// AD-03 Section (D91). `params` is a promise in this Next.js version, read with `use` in a client page. The key restarts the screen for another section.
export default function AdminSectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <SectionScreen key={id} id={id} />;
}
