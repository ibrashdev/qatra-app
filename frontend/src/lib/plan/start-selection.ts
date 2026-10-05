import type { ISODate, Path, TargetScope } from "@/lib/api/types";

// The choices of the start screen (S-08), handed to the next step in memory only (guard 5). A reload loses them (UG-01), so a later
// screen that finds nothing here sends the learner back to /start.
export interface StartSelection {
  editionId: string;
  targetScope: TargetScope; // E14 ordinals, ascending, 1 to 60 entries
  paths: Path[]; // ["quran"] for a Quran edition; a non-empty subset of matn, sanad, grade for a hadith edition
  sessionMinutes: 5 | 10 | 15;
  preferredDate: ISODate | null;
  goalText: string; // the composed sentence or the learner's edit, at most 500 code points after trimming
}

// S-08 may keep extra form state here so that returning from the next step restores every level of the cascade.
export interface StartDraft {
  selection: StartSelection;
  form: Readonly<Record<string, unknown>>;
}

let draft: StartDraft | null = null;

export function setStartDraft(next: StartDraft | null): void {
  draft = next;
}

export function getStartDraft(): StartDraft | null {
  return draft;
}

export function getStartSelection(): StartSelection | null {
  return draft?.selection ?? null;
}
