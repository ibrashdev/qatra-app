"use client";

import type { SimilarQuestion } from "@/lib/api/types";
import { ChoicePiece, type ChoicePieceProps } from "./ChoicePiece";

// S-17 (D31): two options at one position, the true word and a programmatic wrong one. The wrong option is shown only inside its own tile.
export function SimilarDistinction(props: ChoicePieceProps<SimilarQuestion>) {
  return <ChoicePiece {...props} />;
}
