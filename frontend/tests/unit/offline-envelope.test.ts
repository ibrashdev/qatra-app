import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@/lib/api/types";
import { EnvelopeStamper, attachEnvelope, buildEnvelope, clampActivityEvent, eventOrderMs, isFullEnvelope, isUuid } from "@/lib/offline/envelope";
import { makeSnapshot, uuid } from "./offline-support";

const answer = (): SessionEvent => ({ clientEventId: uuid(), type: "answer", questionId: "q", answer: { optionId: "a" }, hintUsed: false, occurredAt: "2026-10-05T10:00:00.000Z", durationMs: 100 });
const activity = (start: string, end: string, activeMs: number): SessionEvent => ({ clientEventId: uuid(), type: "activity", startedAt: start, endedAt: end, activeMs });

describe("envelope (API-spec E21: all nine fields or none)", () => {
  it("is built from the snapshot the run uses, never from a newer one", () => {
    const snapshot = makeSnapshot({ planVersion: 4, bankVersion: 9 });
    expect(buildEnvelope(snapshot, "run", 7)).toEqual({
      clientRunId: "run",
      snapshotId: snapshot.snapshotId,
      protocolVersion: 1,
      planVersion: 4,
      editionId: snapshot.editionId,
      bankVersion: 9,
      normalizationPolicyVersion: "arabic-norm-v1",
      scoringPolicyVersion: "v1",
      localSequence: 7,
    });
  });

  it("recognises a full envelope and rejects each missing or wrong field", () => {
    const full = attachEnvelope(answer(), buildEnvelope(makeSnapshot(), uuid(), 0));
    expect(isFullEnvelope(full)).toBe(true);
    for (const key of ["clientRunId", "snapshotId", "protocolVersion", "planVersion", "editionId", "bankVersion", "normalizationPolicyVersion", "scoringPolicyVersion", "localSequence"]) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[key];
      expect(isFullEnvelope(partial as unknown as SessionEvent)).toBe(false);
    }
    expect(isFullEnvelope({ ...full, localSequence: -1 })).toBe(false);
    expect(isFullEnvelope({ ...full, localSequence: 1.5 })).toBe(false);
    expect(isFullEnvelope(answer())).toBe(false);
  });

  it("checks UUIDs", () => {
    expect(isUuid(uuid())).toBe(true);
    expect(isUuid("run-1")).toBe(false);
    expect(isUuid(5)).toBe(false);
  });
});

describe("EnvelopeStamper", () => {
  it("hands out localSequence 0, 1, 2 for one run id, and continues from startAt after a restart", () => {
    const snapshot = makeSnapshot();
    const runId = uuid();
    const stamper = new EnvelopeStamper(snapshot, runId);
    const stamped = [stamper.stamp(answer()), stamper.stamp(answer()), stamper.stamp(answer())];
    expect(stamped.map((event) => event.localSequence)).toEqual([0, 1, 2]);
    expect(stamped.every((event) => event.clientRunId === runId && isFullEnvelope(event))).toBe(true);
    expect(stamper.nextSequence).toBe(3);
    expect(new EnvelopeStamper(snapshot, runId, 3).stamp(answer()).localSequence).toBe(3);
  });

  it("refuses a run id that is not a UUID and a bad start", () => {
    expect(() => new EnvelopeStamper(makeSnapshot(), "run")).toThrow(/UUID/);
    expect(() => new EnvelopeStamper(makeSnapshot(), uuid(), -1)).toThrow();
  });

  it("does not change the identity of the event it stamps", () => {
    const event = answer();
    expect(new EnvelopeStamper(makeSnapshot(), uuid()).stamp(event)).toMatchObject({ clientEventId: event.clientEventId, questionId: "q", occurredAt: (event as { occurredAt: string }).occurredAt });
  });
});

describe("clamping an activity interval to now (G-17)", () => {
  const now = Date.parse("2026-10-05T10:00:10.000Z");

  it("leaves an interval that already ended alone", () => {
    const event = activity("2026-10-05T10:00:00.000Z", "2026-10-05T10:00:05.000Z", 5000);
    expect(clampActivityEvent(event, now)).toBe(event);
  });

  it("cuts an interval that ends in the future at the device's own now, and never lengthens it", () => {
    const event = activity("2026-10-05T10:00:05.000Z", "2026-10-05T10:00:20.000Z", 15_000);
    expect(clampActivityEvent(event, now)).toMatchObject({ startedAt: "2026-10-05T10:00:05.000Z", endedAt: "2026-10-05T10:00:10.000Z", activeMs: 5000 });
  });

  it("keeps a shorter activeMs and handles a start in the future", () => {
    const short = activity("2026-10-05T10:00:05.000Z", "2026-10-05T10:00:20.000Z", 2000);
    expect(clampActivityEvent(short, now)).toMatchObject({ activeMs: 2000 });
    const future = activity("2026-10-05T10:00:30.000Z", "2026-10-05T10:00:40.000Z", 10_000);
    expect(clampActivityEvent(future, now)).toMatchObject({ startedAt: "2026-10-05T10:00:10.000Z", endedAt: "2026-10-05T10:00:10.000Z", activeMs: 0 });
  });

  it("does not touch answers, and the stamper applies the clamp", () => {
    const event = answer();
    expect(clampActivityEvent(event, now)).toBe(event);
    const stamped = new EnvelopeStamper(makeSnapshot(), uuid()).stamp(activity("2026-10-05T10:00:05.000Z", "2026-10-05T10:00:20.000Z", 15_000), now);
    expect(stamped).toMatchObject({ endedAt: "2026-10-05T10:00:10.000Z", activeMs: 5000 });
  });
});

describe("replay order key", () => {
  it("is occurredAt for an answer and startedAt for activity", () => {
    expect(eventOrderMs(answer())).toBe(Date.parse("2026-10-05T10:00:00.000Z"));
    expect(eventOrderMs(activity("2026-10-05T10:00:03.000Z", "2026-10-05T10:00:09.000Z", 6000))).toBe(Date.parse("2026-10-05T10:00:03.000Z"));
  });
});
