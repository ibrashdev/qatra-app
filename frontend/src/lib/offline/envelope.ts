import type { OfflineEnvelope, PlanSnapshot, SessionEvent } from "@/lib/api/types";
import { OFFLINE_PROTOCOL_VERSION, OfflineError, type AttachEnvelopeFn, type EnvelopedEvent } from "./types";

// The replay envelope of an event recorded on the device (PWA-design 5, API-spec E21): all nine fields or none. The server rejects an un-enveloped event on
// a `prepared` session with `envelope_mismatch`, so every event of a prepared session gets one, even while the device is online.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function buildEnvelope(snapshot: Pick<PlanSnapshot, "snapshotId" | "planVersion" | "editionId" | "bankVersion">, clientRunId: string, localSequence: number): OfflineEnvelope {
  return {
    clientRunId,
    snapshotId: snapshot.snapshotId,
    protocolVersion: OFFLINE_PROTOCOL_VERSION,
    planVersion: snapshot.planVersion,
    editionId: snapshot.editionId,
    bankVersion: snapshot.bankVersion,
    normalizationPolicyVersion: "arabic-norm-v1",
    scoringPolicyVersion: "v1",
    localSequence,
  };
}

export const attachEnvelope: AttachEnvelopeFn = (event, envelope) => ({ ...event, ...envelope }) as EnvelopedEvent;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

export function isFullEnvelope(event: SessionEvent): event is EnvelopedEvent {
  const e = event as Partial<OfflineEnvelope>;
  return (
    isNonEmptyString(e.clientRunId) &&
    isNonEmptyString(e.snapshotId) &&
    e.protocolVersion === OFFLINE_PROTOCOL_VERSION &&
    typeof e.planVersion === "number" &&
    Number.isInteger(e.planVersion) &&
    isNonEmptyString(e.editionId) &&
    typeof e.bankVersion === "number" &&
    Number.isInteger(e.bankVersion) &&
    e.normalizationPolicyVersion === "arabic-norm-v1" &&
    e.scoringPolicyVersion === "v1" &&
    typeof e.localSequence === "number" &&
    Number.isInteger(e.localSequence) &&
    e.localSequence >= 0
  );
}

// G-17: a device clock that runs ahead gets `activity_out_of_bounds` (endedAt past the server's now plus a minute). An interval is cut at the device's own
// now when it is made. Pure, so it is tested without a clock. The interval never grows: `activeMs` only shrinks.
export function clampActivityEvent<T extends SessionEvent>(event: T, nowMs: number): T {
  if (event.type !== "activity") return event;
  const startedMs = Date.parse(event.startedAt);
  const endedMs = Date.parse(event.endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= nowMs) return event;
  const clampedEnd = nowMs;
  const clampedStart = Math.min(startedMs, clampedEnd);
  const span = Math.max(0, clampedEnd - clampedStart);
  return { ...event, startedAt: new Date(clampedStart).toISOString(), endedAt: new Date(clampedEnd).toISOString(), activeMs: Math.min(event.activeMs, Math.round(span)) };
}

// One stamper per run: it hands out localSequence 0, 1, 2 ... for the run's `clientRunId`. The run record in IndexedDB advances `nextLocalSequence` in the
// same transaction as the enqueue, so a restored run continues where it stopped (pass `run.nextLocalSequence` as `startAt`).
export class EnvelopeStamper {
  #next: number;

  constructor(
    private readonly snapshot: Pick<PlanSnapshot, "snapshotId" | "planVersion" | "editionId" | "bankVersion">,
    readonly clientRunId: string,
    startAt = 0,
  ) {
    if (!isUuid(clientRunId)) throw new OfflineError("invalid_run", "clientRunId must be a UUID.");
    if (!Number.isInteger(startAt) || startAt < 0) throw new OfflineError("invalid_run", "startAt must be a non-negative integer.");
    this.#next = startAt;
  }

  get nextSequence(): number {
    return this.#next;
  }

  stamp(event: SessionEvent, nowMs: number = Date.now()): EnvelopedEvent {
    const clamped = clampActivityEvent(event, nowMs);
    const stamped = attachEnvelope(clamped, buildEnvelope(this.snapshot, this.clientRunId, this.#next));
    this.#next += 1;
    return stamped;
  }
}

// The replay order of the server (API-spec E21): occurredAt, or startedAt for an activity interval; the server never reorders.
export function eventOrderMs(event: SessionEvent): number {
  return Date.parse(event.type === "answer" ? event.occurredAt : event.startedAt);
}
