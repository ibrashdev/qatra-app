"use client";

import { useCallback, useEffect, useState } from "react";
import { useApiRuntime } from "@/lib/api/react";
import { getLessonSection, getLessons } from "@/lib/api/lesson-endpoints";
import type { LessonSectionDetail, LessonsResponse } from "@/lib/api/types";
import { classifyLessonsError, type LessonsFailure } from "./lessons-model";

export type LessonsLoad =
  | { status: "loading" }
  | { status: "error"; failure: LessonsFailure }
  // An account without an active plan (409 `plan_not_active`): the tab stays open and points to the start of one.
  | { status: "no_plan" }
  | { status: "ready"; lessons: LessonsResponse };

// The list of the lessons tab: one read, repeated on a retry (a read changes nothing).
export function useLessonsList(): { state: LessonsLoad; reload: () => void } {
  const { client } = useApiRuntime();
  const [state, setState] = useState<LessonsLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const lessons = await getLessons(client, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ status: "ready", lessons });
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure = classifyLessonsError(error);
        if (failure.kind === "aborted") return;
        setState(failure.kind === "plan_not_active" ? { status: "no_plan" } : { status: "error", failure });
      }
    })();
    return () => controller.abort();
  }, [client, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, reload };
}

export type SectionLoad =
  | { status: "loading" }
  | { status: "error"; failure: LessonsFailure }
  // A section the active plan does not hold (404), or an account without an active plan (409): the reader says so and points back to the list.
  | { status: "out_of_plan" }
  | { status: "ready"; detail: LessonSectionDetail };

// One section of the reader. `sectionId` is null for a route id that is not a number: that is a section the plan does not hold, without a request.
export function useLessonSection(sectionId: number | null): { state: SectionLoad; reload: () => void } {
  const { client } = useApiRuntime();
  const [state, setState] = useState<SectionLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (sectionId === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const detail = await getLessonSection(client, sectionId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ status: "ready", detail });
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure = classifyLessonsError(error);
        if (failure.kind === "aborted") return;
        setState(failure.kind === "not_found" || failure.kind === "plan_not_active" ? { status: "out_of_plan" } : { status: "error", failure });
      }
    })();
    return () => controller.abort();
  }, [client, sectionId, attempt]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  return { state: sectionId === null ? { status: "out_of_plan" } : state, reload };
}
