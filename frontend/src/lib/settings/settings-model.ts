import type { UpdateProfileRequest } from "@/lib/api/settings-endpoints";
import type { Profile } from "@/lib/api/types";

// The pure rules of S-22 (UI-screens S-22 section 3, "Form"): what the controls show first, and which fields a save sends.

export type Minutes = Profile["sessionMinutes"];

export interface SettingsValues {
  language: Profile["language"];
  sessionMinutes: Minutes;
  timeZone: string;
  inApp: boolean;
}

// What the controls show: the value the learner chose last, which is the pending one while a change waits for its day, else the value in force.
export function chosenValues(profile: Profile): SettingsValues {
  return {
    language: profile.language,
    sessionMinutes: profile.pendingSettings?.sessionMinutes ?? profile.sessionMinutes,
    timeZone: profile.pendingSettings?.timeZone ?? profile.timeZone,
    inApp: profile.reminderSettings.inApp,
  };
}

// E12 receives only the fields that differ from what was chosen last. An empty patch means there is nothing to save, so nothing is sent.
export function changedValues(chosen: SettingsValues, draft: SettingsValues): UpdateProfileRequest {
  const patch: UpdateProfileRequest = {};
  if (draft.language !== chosen.language) patch.language = draft.language;
  if (draft.sessionMinutes !== chosen.sessionMinutes) patch.sessionMinutes = draft.sessionMinutes;
  if (draft.timeZone !== chosen.timeZone) patch.timeZone = draft.timeZone;
  if (draft.inApp !== chosen.inApp) patch.reminderSettings = { inApp: draft.inApp };
  return patch;
}

// The wait of c13 for one field, only while the profile holds a pending value for it: the value in force and the day the change starts.
export interface PendingChange<T> {
  inForce: T;
  effectiveDate: string;
}

export function pendingMinutes(profile: Profile): PendingChange<Minutes> | null {
  const pending = profile.pendingSettings;
  if (pending === null || pending.sessionMinutes === undefined) return null;
  return { inForce: profile.sessionMinutes, effectiveDate: pending.effectiveDate };
}

export function pendingTimeZone(profile: Profile): PendingChange<string> | null {
  const pending = profile.pendingSettings;
  if (pending === null || pending.timeZone === undefined) return null;
  return { inForce: profile.timeZone, effectiveDate: pending.effectiveDate };
}
