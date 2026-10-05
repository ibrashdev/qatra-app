// The one-time arrival note of S-11 after S-34 confirms (UI-screens S-34 "Confirming; confirmed"): the toast «تم اعتماد خطتك.» or «تم اعتماد التعديل.».
// Held in memory only, never a URL parameter. S-11 reads it with takePlanConfirmed() and shows the toast and the G-32 banner.

export type PlanConfirmedKind = "created" | "revised";

let raised: PlanConfirmedKind | null = null;

export function raisePlanConfirmed(kind: PlanConfirmedKind): void {
  raised = kind;
}

export function peekPlanConfirmed(): PlanConfirmedKind | null {
  return raised;
}

// Consumes the note: it is shown once.
export function takePlanConfirmed(): PlanConfirmedKind | null {
  const kind = raised;
  raised = null;
  return kind;
}
