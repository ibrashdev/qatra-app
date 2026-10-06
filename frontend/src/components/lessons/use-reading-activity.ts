"use client";

import { useEffect, useMemo, useState } from "react";
import { DurableOnlineQueue, resolveOnlineBinding } from "@/components/session/durable-online-queue";
import { activityEvent } from "@/components/session/session-events";
import { useActivityClock } from "@/components/session/use-activity";
import { useApiRuntime } from "@/lib/api/react";
import { postSessionEvents, startDailySession } from "@/lib/api/session-endpoints";

// How long the reader stays open before it looks for today's session, so a glance at a lesson creates nothing; and how long it waits before it asks again
// after a failure.
export const READING_SETTLE_MS = 5000;
export const READING_RETRY_MS = 30_000;

// Reading counts toward the daily goal (D40, D92): the time the reader is on screen is credited like any other verified active time, as E21 activity events
// of today's daily session. The reader has no session of its own and no schema change was made for it: it uses the daily session of the day.
//
// - The session comes from E18 (`openSessionId`). Only when E18 shows no session and no activity yet today (`dailyActiveMs` 0 and the day not completed) does the
//   reader call E20 `daily`, the call the Today button makes. E18 has no field that says today's daily session was completed, so any activity or a
//   completed day with no open session is read as "a daily session may already be completed": the reader then creates nothing and credits nothing (reading
//   still works, no error is shown). It never creates a second daily session after one was completed. The look-up happens once the reader has been open for
//   `READING_SETTLE_MS`, and the clock starts only after that: E21 refuses an interval that began before its session was created, so an interval must
//   never start before the session is known.
// - Intervals follow the session's own rules (use-activity.ts): the clock runs while the page is visible and ends at a hide, at the 5 minute cut and when
//   the reader closes. Each interval is queued and sent at once, through the session's event queue. Nothing but ids and times is ever sent, never the text.
// - Offline or failing: each interval is committed to the online journal (kind `lesson`, activity events only) before it is counted, so a reload or a closed
//   reader no longer loses it; it waits there and is sent again at the next interval, when the connection returns, or by the foreground sync. Where the
//   device cannot hold it the interval waits in the page's memory as before. The reader holds no run lock and owes no finish. A session that closed meanwhile (`session_closed`) ends the crediting for this visit: no
//   new session is created. An account without an active plan credits nothing, silently: reading never shows an error for its time.
export function useReadingActivity(active: boolean): void {
  const { api, client } = useApiRuntime();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false); // nothing is credited for this visit: no plan, a completed day, or a session that closed

  // One queue per session: its events are sent to that session and to no other.
  const queue = useMemo(
    () =>
      sessionId === null
        ? null
        : new DurableOnlineQueue({ sessionId, kind: "lesson", send: (events) => postSessionEvents(client, sessionId, events), resolveBinding: () => resolveOnlineBinding(api) }),
    [api, client, sessionId],
  );
  useEffect(() => {
    void queue?.start();
  }, [queue]);

  // The session that closed (completed on another screen) takes no more time, and no new session is made for the rest of this visit. The events it
  // refused are final.
  useEffect(() => {
    if (queue === null || sessionId === null) return;
    queue.setResponseHandler((response) => {
      if (response.rejected.some((entry) => entry.code === "session_closed")) {
        setStopped(true);
        setSessionId((current) => (current === sessionId ? null : current));
      }
    });
  }, [queue, sessionId]);

  useEffect(() => {
    if (!active || sessionId !== null || stopped) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const look = async (): Promise<void> => {
      try {
        const today = await api.today({ signal: controller.signal });
        if (controller.signal.aborted) return;
        if (today.plan === null) {
          setStopped(true);
          return;
        }
        let found = today.openSessionId;
        if (found === null) {
          // A daily session that was completed leaves no trace in E18: any activity, or a completed day, with no open session means "do not create one".
          if (today.dailyActiveMs > 0 || today.dailyCompleted) {
            setStopped(true);
            return;
          }
          found = (await startDailySession(client, { planId: today.plan.planId, planVersion: today.plan.currentVersion }, { signal: controller.signal })).sessionId;
        }
        if (!controller.signal.aborted) setSessionId(found);
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void look(), READING_RETRY_MS);
      }
    };
    timer = window.setTimeout(() => void look(), READING_SETTLE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, sessionId, stopped, api, client]);

  useActivityClock({
    running: active && queue !== null,
    onInterval: (startedAtMs, endedAtMs) => {
      const event = activityEvent(startedAtMs, endedAtMs);
      if (event === null || queue === null) return;
      queue.enqueue(event);
      void queue.flush();
    },
  });

  // The connection is back: send what waits.
  useEffect(() => {
    if (queue === null) return;
    const onOnline = () => {
      if (queue.size > 0) void queue.flush();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [queue]);
}
