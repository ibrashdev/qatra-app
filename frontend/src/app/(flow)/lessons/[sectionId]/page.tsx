"use client";

import { use } from "react";
import { LessonReaderScreen } from "@/components/lessons/LessonReaderScreen";

// The reader of one section (D90), a focus flow. `params` is a promise in this Next.js version, read with `use` in a client page, as S-19 and S-34 do.
export default function LessonReaderPage({ params }: { params: Promise<{ sectionId: string }> }) {
  const { sectionId } = use(params);
  return <LessonReaderScreen rawId={sectionId} />;
}
