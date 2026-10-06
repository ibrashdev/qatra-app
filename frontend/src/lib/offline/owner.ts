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
import { accountKeyOf, countOnlineEvents } from "./online-journal";
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
// 401 does not wipe anything: the same learner may log in again, and the unsent answers are still theirs. An owner can also be username-only (no ownership
// id, because nothing was downloaded): it is the account the online journal is bound to, and it is isolated exactly like a downloaded copy.

const normalize = accountKeyOf;

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
    // A username-only owner (the online journal of another account) is not overwritten either: it has to be wiped first.
    if (current.ownerId === null && current.username !== null && normalize(current.username) !== normalize(username)) {
      throw new OfflineError("owner_mismatch", "The local copy belongs to another account.");
    }
    const next: OwnerState = { ...current, ownerId, username, updatedAt: nowIso() };
    await ctx.put("ownerState", next, OWNER_KEY);
    return next;
  });
};

// The unsent answers a clear would delete: the offline outbox of the downloaded copy plus the online journal of the signed-in account (queued, pending and
// blocked ones alike). A store that cannot be read counts as nothing.
async function countUnsynced(owner: OwnerState | null): Promise<number> {
  if (owner === null) return 0;
  let total = 0;
  if (owner.ownerId !== null) {
    try {
      total += (await countOutbox(owner.ownerId)).total;
    } catch {
      // unreadable: nothing is counted
    }
  }
  if (owner.username !== null && accountKeyOf(owner.username) !== "") {
    try {
      total += (await countOnlineEvents(accountKeyOf(owner.username))).total;
    } catch {
      // unreadable: nothing is counted
    }
  }
  return total;
}

async function clearLogoutPendingFlag(): Promise<void> {
  await runTx(["ownerState"], "readwrite", async (ctx) => {
    const current = await readOwnerInTx(ctx);
    if (current === undefined || !current.logoutPending) return;
    await ctx.put("ownerState", { ...current, logoutPending: false, updatedAt: nowIso() }, OWNER_KEY);
  });
}

// After a successful login or registration the account is on this device for good: the owed server logout is moot, and a device whose owner has no
// username yet records it, so an online session can bind to the account without a request. An owner that already has a username is never renamed.
async function settleLogin(username: string): Promise<void> {
  const name = username.trim();
  await runTx(["ownerState"], "readwrite", async (ctx) => {
    const current = await readOwnerInTx(ctx);
    const locked = readLockMarker() || current?.clearFailed === true;
    const recordName = !locked && name !== "" && (current === undefined || current.username === null);
    if (current === undefined && !recordName) return;
    if (current !== undefined && !current.logoutPending && !recordName) return;
    const base = current ?? initialOwnerState();
    await ctx.put("ownerState", { ...base, logoutPending: false, username: recordName ? name : base.username, updatedAt: nowIso() }, OWNER_KEY);
  });
}

// Called after a successful login or registration (G-04). Another username wipes the copy before anything else is shown, and so does a username-only owner
// of another account (the online journal); the same one keeps it. Either way the new session replaces the old one on the server, so an owed offline logout
// is moot and must not log the new session out.
export const wipeIfDifferentAccount: WipeIfDifferentAccountFn = async (username) => {
  const owner = await readOwnerState();
  let wiped = false;
  if (owner !== null) {
    const different = owner.username === null ? owner.ownerId !== null : normalize(owner.username) !== normalize(username);
    if (different) {
      // `undefined` clears whatever is there, also a username-only owner that has no ownership id to compare.
      await clearAccountCacheWith(owner.ownerId ?? undefined);
      wiped = true;
    }
  }
  await settleLogin(username);
  return wiped;
};

// Offline-first logout (PWA-design 7): the copy is wiped at once; `logoutPending` records that the server logout is still owed when the device was offline.
export const logoutLocally: LogoutLocallyFn = async ({ serverLogoutDone }) => {
  const owner = await readOwnerState();
  const discardedEvents = await countUnsynced(owner);
  await clearAccountCacheWith(owner?.ownerId ?? undefined, { logoutPending: !serverLogoutDone });
  return { discardedEvents, serverLogoutPending: !serverLogoutDone };
};

// The learner's own «clear the local copy»: it never deletes the account, and the unsynced answers are lost.
export const clearLocalCopy: ClearLocalCopyFn = async () => {
  const owner = await readOwnerState();
  const discardedEvents = await countUnsynced(owner);
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
