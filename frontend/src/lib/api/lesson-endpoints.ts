import type { ApiClient, RequestOptions } from "./client";
import type { LessonSectionDetail, LessonsResponse } from "./types";

// The lessons reader (D90): two reads, no body, no query. Kept apart from endpoints.ts like the session and games modules; they take the client of the
// runtime, so the mock layer and the real server behave alike. A read changes nothing, so both may be repeated by the client.

type ReadOptions = Pick<RequestOptions, "signal" | "timeoutMs" | "retry">;

// GET /api/lessons: the sections of the active plan's scope in the plan's order. 409 `version_conflict` (`plan_not_active`) is an account without an
// active plan.
export function getLessons(client: ApiClient, options?: ReadOptions): Promise<LessonsResponse> {
  return client.get<LessonsResponse>("/lessons", options);
}

// GET /api/lessons/{sectionId}: the text of one section. 404 is a section outside the plan's scope.
export function getLessonSection(client: ApiClient, sectionId: number, options?: ReadOptions): Promise<LessonSectionDetail> {
  return client.get<LessonSectionDetail>(`/lessons/${encodeURIComponent(String(sectionId))}`, options);
}
