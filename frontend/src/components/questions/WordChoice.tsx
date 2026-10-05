"use client";

import type { WordChoiceQuestion } from "@/lib/api/types";
import { ChoicePiece, type ChoicePieceProps } from "./ChoicePiece";

// S-16: the missing word (four options) or the segment that comes next (three options of two to four words), from the same edition.
export function WordChoice(props: ChoicePieceProps<WordChoiceQuestion>) {
  return <ChoicePiece {...props} />;
}
