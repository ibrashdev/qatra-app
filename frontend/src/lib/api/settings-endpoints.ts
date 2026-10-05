import type { ApiClient, RequestOptions } from "./client";
import type { Profile } from "./types";

// E12 as the settings screen (S-22) uses it. Kept apart from endpoints.ts while that file belongs to another package; the coordinator may move the
// function into `Endpoints`. It takes the client of the runtime, so the mock layer and the real server behave alike. A state-changing submit is
// never retried automatically: the caller decides what a retry does.

type PressOptions = Pick<RequestOptions, "signal">;

// E12 (API-spec 4.3): only the fields that changed, at least one; any other property is `422 forbidden_field`. `language` and the reminder take effect
// at once, `sessionMinutes` and `timeZone` are recorded in `pendingSettings` for the next learning day (D57).
export interface UpdateProfileRequest {
  language?: Profile["language"];
  sessionMinutes?: Profile["sessionMinutes"];
  timeZone?: string;
  reminderSettings?: { inApp: boolean };
}

export function updateProfile(client: ApiClient, patch: UpdateProfileRequest, options?: PressOptions): Promise<Profile> {
  return client.patch<Profile>("/me", patch, { signal: options?.signal });
}
