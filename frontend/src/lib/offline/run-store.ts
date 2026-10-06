import { newEventId } from "@/components/session/session-events";
import { nowIso, requireOwnerInTx, readOwnerInTx, readLockMarker, runTx } from "./db";
import {
  OfflineError,
  type ActiveRunRecord,
  type FinishRunFn,
  type ListRunsFn,
  type ReadRunFn,
  type SaveRunFn,
  type StartRunFn,
} from "./types";

// `activeRuns` (offline-spec 2.2): the state of a local run, saved before the page closes so a reload resumes it. It holds ids, the step index and the
// provisional verdicts by question, never answer text (a recall answer waits in the outbox until the server has it). Every call checks the owner and
// the generation inside its own transaction.

export const startRun: StartRunFn = async (ownerId, input, options) => {
  if (input.snapshotId === "" || input.sessionId === "") throw new OfflineError("invalid_run", "A run needs a snapshot and a session.");
  const now = nowIso();
  return runTx(["ownerState", "activeRuns"], "readwrite", async (ctx) => {
    const owner = await requireOwnerInTx(ctx, ownerId, options);
    const run: ActiveRunRecord = {
      clientRunId: newEventId(), // a new run id for every run, even over the same prepared session (G-02)
      ownerId,
      generation: owner.generation,
      snapshotId: input.snapshotId,
      sessionId: input.sessionId,
      kind: input.kind,
      stepIndex: 0,
      answered: {},
      nextLocalSequence: 0,
      startedAt: now,
      updatedAt: now,
      status: "active",
      extra: {},
    };
    await ctx.put("activeRuns", run);
    return run;
  });
};

export const saveRun: SaveRunFn = async (ownerId, clientRunId, patch) => {
  const now = nowIso();
  return runTx(["ownerState", "activeRuns"], "readwrite", async (ctx) => {
    const owner = await requireOwnerInTx(ctx, ownerId);
    const run = await ctx.get<ActiveRunRecord>("activeRuns", clientRunId);
    if (run === undefined) throw new OfflineError("not_found", "The run does not exist.");
    if (run.ownerId !== ownerId || run.generation !== owner.generation) throw new OfflineError("generation_mismatch", "The run belongs to an earlier copy.");
    const next: ActiveRunRecord = {
      ...run,
      stepIndex: patch.stepIndex ?? run.stepIndex,
      answered: patch.answered ?? run.answered,
      extra: patch.extra ?? run.extra,
      updatedAt: now,
    };
    await ctx.put("activeRuns", next);
    return next;
  });
};

export const readRun: ReadRunFn = async (ownerId, clientRunId) => {
  if (readLockMarker()) return null;
  return runTx(["ownerState", "activeRuns"], "readonly", async (ctx) => {
    const owner = await readOwnerInTx(ctx);
    if (owner === undefined || owner.ownerId !== ownerId || owner.clearFailed) return null;
    const run = await ctx.get<ActiveRunRecord>("activeRuns", clientRunId);
    return run !== undefined && run.ownerId === ownerId ? run : null;
  });
};

export const listRuns: ListRunsFn = async (ownerId, status) => {
  if (readLockMarker()) return [];
  return runTx(["ownerState", "activeRuns"], "readonly", async (ctx) => {
    const owner = await readOwnerInTx(ctx);
    if (owner === undefined || owner.ownerId !== ownerId || owner.clearFailed) return [];
    const runs = await ctx.allByIndex<ActiveRunRecord>("activeRuns", "byOwner", ownerId);
    return status === undefined ? runs : runs.filter((run) => run.status === status);
  });
};

// A finished or abandoned run stays only as long as its record is useful; the events it made live in the outbox. Closing it frees the snapshot to be
// replaced by a newer download.
export const finishRun: FinishRunFn = async (ownerId, clientRunId, status) => {
  const now = nowIso();
  await runTx(["ownerState", "activeRuns"], "readwrite", async (ctx) => {
    await requireOwnerInTx(ctx, ownerId);
    const run = await ctx.get<ActiveRunRecord>("activeRuns", clientRunId);
    if (run === undefined || run.ownerId !== ownerId) return;
    await ctx.put("activeRuns", { ...run, status, updatedAt: now });
  });
};

// Runs already closed are removed (their events are in the outbox), so the store does not grow.
export async function discardClosedRuns(ownerId: string): Promise<number> {
  return runTx(["ownerState", "activeRuns"], "readwrite", async (ctx) => {
    await requireOwnerInTx(ctx, ownerId);
    const runs = await ctx.allByIndex<ActiveRunRecord>("activeRuns", "byOwner", ownerId);
    let removed = 0;
    for (const run of runs) {
      if (run.status === "active") continue;
      await ctx.delete("activeRuns", run.clientRunId);
      removed += 1;
    }
    return removed;
  });
}
