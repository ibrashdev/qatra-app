import { describe, expect, it, vi } from "vitest";
import { SessionEventQueue } from "@/components/session/event-queue";
import { activityEvent, answerEvent } from "@/components/session/session-events";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import type { DailyProgress, EventsResponse, SessionEvent } from "@/lib/api/types";

const T0 = Date.parse("2026-10-05T07:00:00Z");
const DAILY: DailyProgress = { learningDate: "2026-10-05", dailyActiveMs: 0, dailyGoalMs: 600_000, dailyPercent: 0, dailyCompleted: false, extraActiveMs: 0 };

const answerOf = (suffix: string): SessionEvent => answerEvent({ questionId: `q-${suffix}`, answer: { optionId: "a" }, hintUsed: false, occurredAtMs: T0, durationMs: 1000 });

// The server's answer for a batch: every event acknowledged.
const acknowledge = (events: readonly SessionEvent[]): EventsResponse => ({ acknowledged: events.map((event) => event.clientEventId), duplicate: [], pending: [], rejected: [], results: [], daily: DAILY });

const tooLarge = () => new ApiError({ status: 413, code: "payload_too_large", message: "too large" });

describe("the event queue of S-19 (page memory, idempotent by clientEventId)", () => {
  it("sends what waits in the order it was made, at most 100 events to a request", async () => {
    const sent: SessionEvent[][] = [];
    const queue = new SessionEventQueue({ send: async (events) => (sent.push(events), acknowledge(events)) });
    const all = Array.from({ length: 250 }, (_, index) => answerOf(String(index)));
    all.forEach((event) => queue.enqueue(event));
    expect(queue.size).toBe(250);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(sent.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(sent.flat().map((event) => event.clientEventId)).toEqual(all.map((event) => event.clientEventId));
    expect(queue.size).toBe(0);
  });

  it("keeps every event after a failure and resends the same ids, never new ones", async () => {
    const bodies: string[][] = [];
    let failures = 2;
    const queue = new SessionEventQueue({
      send: async (events) => {
        bodies.push(events.map((event) => event.clientEventId));
        if (failures > 0) {
          failures -= 1;
          throw new ConnectivityError("network");
        }
        return acknowledge(events);
      },
    });
    const first = answerOf("1");
    const second = activityEvent(T0, T0 + 60_000);
    if (second === null) throw new Error("interval expected");
    queue.enqueue(first);
    queue.enqueue(second);

    const failed = await queue.flush();
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toBeInstanceOf(ConnectivityError);
    expect(queue.size).toBe(2);
    await queue.flush();
    expect(queue.size).toBe(2);
    expect(await queue.flush()).toEqual({ ok: true });
    expect(queue.size).toBe(0);
    const ids = [first.clientEventId, second.clientEventId];
    expect(bodies).toEqual([ids, ids, ids]);
  });

  it("keeps an event added while a request is in flight and sends it next", async () => {
    const gate: { release?: () => void } = {};
    const sent: string[][] = [];
    const queue = new SessionEventQueue({
      send: (events) => {
        sent.push(events.map((event) => event.clientEventId));
        if (sent.length === 1) return new Promise<EventsResponse>((resolve) => (gate.release = () => resolve(acknowledge(events))));
        return Promise.resolve(acknowledge(events));
      },
    });
    const first = answerOf("1");
    const late = answerOf("2");
    queue.enqueue(first);
    const flushing = queue.flush();
    await vi.waitFor(() => expect(gate.release).toBeDefined());
    queue.enqueue(late);
    const second = queue.flush();
    gate.release?.();
    expect(await flushing).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(sent).toEqual([[first.clientEventId], [late.clientEventId]]);
  });

  it("never runs two requests at once, so the order of the events is the order they were made in", async () => {
    let running = 0;
    let peak = 0;
    const queue = new SessionEventQueue({
      send: async (events) => {
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running -= 1;
        return acknowledge(events);
      },
    });
    queue.enqueue(answerOf("1"));
    const flushes = [queue.flush(), queue.flush()];
    queue.enqueue(answerOf("2"));
    flushes.push(queue.flush());
    await Promise.all(flushes);
    expect(peak).toBe(1);
    expect(queue.size).toBe(0);
  });

  it("settles a pending or a rejected event for good: the handler hears of it and it is not sent again", async () => {
    const seen: EventsResponse[] = [];
    const sends = vi.fn(async (events: readonly SessionEvent[]): Promise<EventsResponse> => ({
      ...acknowledge([]),
      pending: [{ clientEventId: events[0]?.clientEventId ?? "", reasonCode: "content_unverifiable" }],
      rejected: [{ clientEventId: events[1]?.clientEventId ?? "", code: "out_of_scope" }],
    }));
    const queue = new SessionEventQueue({ send: sends });
    queue.setResponseHandler((response) => seen.push(response));
    queue.enqueue(answerOf("1"));
    queue.enqueue(answerOf("2"));
    await queue.flush();
    expect(queue.size).toBe(0);
    expect(seen).toHaveLength(1);
    await queue.flush();
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("answers 413 by resending in smaller batches without a message (G-19)", async () => {
    const sizes: number[] = [];
    const queue = new SessionEventQueue({
      send: async (events) => {
        sizes.push(events.length);
        if (events.length > 3) throw tooLarge();
        return acknowledge(events);
      },
    });
    Array.from({ length: 10 }, (_, index) => answerOf(String(index))).forEach((event) => queue.enqueue(event));
    expect(await queue.flush()).toEqual({ ok: true });
    expect(sizes).toEqual([10, 5, 2, 2, 2, 2, 2]);
    expect(queue.size).toBe(0);
  });

  it("drops one event that is too large alone, and reports it while the rest goes on", async () => {
    const queue = new SessionEventQueue({
      send: async (events) => {
        if (events.some((event) => event.type === "answer" && event.questionId === "q-big")) throw tooLarge();
        return acknowledge(events);
      },
    });
    const big = answerOf("big");
    const fine = answerOf("fine");
    queue.enqueue(big);
    queue.enqueue(fine);
    const result = await queue.flush();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(ApiError);
    expect(queue.size).toBe(0);
  });

  it("stops at the first other error and leaves the unsent events queued", async () => {
    const queue = new SessionEventQueue({
      send: async () => {
        throw new ApiError({ status: 503, code: "unavailable", message: "later" });
      },
    });
    queue.enqueue(answerOf("1"));
    const result = await queue.flush();
    expect(result.ok).toBe(false);
    expect(queue.size).toBe(1);
  });
});
