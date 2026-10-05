import { logout } from "@/lib/api/account-endpoints";
import { isSessionEnded } from "@/lib/api/errors";
import {
  OWNER_KEY,
  clearAccountCacheWith,
  initialOwnerState,
  nowIso,
  readLockMarker,
  readOwnerInTx,
  runTx,
  deleteOfflineDatabase,
} from "./db";
import { countOutbox } from "./outbox";
import {
  OfflineError,
  type AdoptOwnerFn,
  type ClearLocalCopyFn,
  type CompletePendingLogoutFn,
  type IsOfflineLockedFn,
  type LogoutLocallyFn,
  type MatchOwnerFn,
  type OwnerState,
  type ReadOwnerStateFn,
  type WipeIfDifferentAccountFn,
} from "./types";

// Account isolation (PWA-design 7, offline-spec 2.3, G-04). One owner per device: `ownerState['current']` holds the ownership id and the username the
// learner had at download. A learner who logs in as another username, logs out, deletes the account or clears the copy loses the local copy first. A plain
// 401 does not wipe anything: the same learner may log in again, and the unsent answers are still theirs.

const normalize = (username: string): string => username.trim().toLowerCase();

export const readOwnerState: ReadOwnerStateFn = async () => {
  const owner = await runTx(["ownerState"], "readonly", (ctx) => readOwnerInTx(ctx));
  return owner ?? null;
};

// Locked after a failed clear: the marker in localStorage survives an IndexedDB failure, the flag in IndexedDB survives a lost marker.
export const isOfflineLocked: IsOfflineLockedFn = async () => {
  if (readLockMarker()) return true;
  try {
    return (await readOwnerState())?.clearFailed === true;
  } catch {
    return false;
  }
};

export const matchOwner: MatchOwnerFn = async (username) => {
  const owner = await readOwnerState();
  if (owner === null || owner.ownerId === null) return { kind: "none" };
  if (owner.username !== null && normalize(owner.username) === normalize(username)) return { kind: "match", owner };
  return { kind: "mismatch", owner };
};

// Records who the local copy belongs to. A device has one owner: another owner has to be wiped first, never overwritten.
export const adoptOwner: AdoptOwnerFn = async ({ ownerId, username }) => {
  if (ownerId === "") throw new OfflineError("owner_mismatch", "An owner id is required.");
  return runTx(["ownerState"], "readwrite", async (ctx) => {
    if (readLockMarker()) throw new OfflineError("locked", "The local copy is locked until it has been cleared.");
    const current = (await readOwnerInTx(ctx)) ?? initialOwnerState();
    if (current.clearFailed) throw new OfflineError("locked", "The local copy is locked until it has been cleared.");
    if (current.ownerId !== null && current.ownerId !== ownerId) throw new OfflineError("owner_mismatch", "The local copy belongs to another account.");
    const next: OwnerState = { ...current, ownerId, username, updatedAt: nowIso() };
    await ctx.put("ownerState", next, OWNER_KEY);
    return next;
  });
};

async function countUnsynced(ownerId: string | null): Promise<number> {
  if (ownerId === null) return 0;
  try {
    return (await countOutbox(ownerId)).total;
  } catch {
    return 0;
  }
}

async function clearLogoutPendingFlag(): Promise<void> {
  await runTx(["ownerState"], "readwrite", async (ctx) => {
    const current = await readOwnerInTx(ctx);
    if (current === undefined || !current.logoutPending) return;
    await ctx.put("ownerState", { ...current, logoutPending: false, updatedAt: nowIso() }, OWNER_KEY);
  });
}

// Called after a successful login or registration (G-04). Another username wipes the copy before anything else is shown; the same one keeps it. Either
// way the new session replaces the old one on the server, so an owed offline logout is moot and must not log the new session out.
export const wipeIfDifferentAccount: WipeIfDifferentAccountFn = async (username) => {
  const owner = await readOwnerState();
  if (owner === null) return false;
  let wiped = false;
  if (owner.ownerId !== null && (owner.username === null || normalize(owner.username) !== normalize(username))) {
    await clearAccountCacheWith(owner.ownerId);
    wiped = true;
  }
  await clearLogoutPendingFlag();
  return wiped;
};

// Offline-first logout (PWA-design 7): the copy is wiped at once; `logoutPending` records that the server logout is still owed when the device was offline.
export const logoutLocally: LogoutLocallyFn = async ({ serverLogoutDone }) => {
  const owner = await readOwnerState();
  const discardedEvents = await countUnsynced(owner?.ownerId ?? null);
  await clearAccountCacheWith(owner?.ownerId ?? undefined, { logoutPending: !serverLogoutDone });
  return { discardedEvents, serverLogoutPending: !serverLogoutDone };
};

// The learner's own «clear the local copy»: it never deletes the account, and the unsynced answers are lost.
export const clearLocalCopy: ClearLocalCopyFn = async () => {
  const owner = await readOwnerState();
  const discardedEvents = await countUnsynced(owner?.ownerId ?? null);
  await clearAccountCacheWith(owner?.ownerId ?? undefined);
  return { discardedEvents };
};

// On reconnect, before the old session is used again: finish the logout that was owed. 204 and 401 both mean the session is gone. Any other failure keeps
// the flag so the next foreground check tries again.
export const completePendingLogout: CompletePendingLogoutFn = async (client) => {
  const owner = await readOwnerState();
  if (owner === null || !owner.logoutPending) return "none";
  try {
    await logout(client);
  } catch (error) {
    if (!isSessionEnded(error)) return "failed";
  }
  await clearLogoutPendingFlag();
  return "done";
};

// Explicit storage repair after a clear that failed: removes the whole database. Resolves true when the personal view can open again.
export async function repairOfflineStorage(): Promise<boolean> {
  return deleteOfflineDatabase();
}
