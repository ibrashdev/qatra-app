"use client";

import { use } from "react";
import { EditionScreen } from "@/components/admin/EditionScreen";

// AD-02 Edition (D91). `params` is a promise in this Next.js version, read with `use` in a client page. The key restarts the screen for another edition.
export default function AdminEditionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <EditionScreen key={id} id={id} />;
}
