import { parseSnapshot, snapshotKey, type WorkspaceSnapshot } from "@onoff/api-client";

// Last known inbox, kept in this browser so the next visit paints immediately.
// It holds phone numbers and message previews: it is deleted on sign-out and every
// failure (private mode, quota, damaged content) simply means a normal load.
type SnapshotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function browserStorage(): SnapshotStorage | null {
  try { return window.localStorage; } catch { return null; }
}

export function loadWorkspaceSnapshot<Organization, Line>(userId: string, storage: SnapshotStorage | null = browserStorage(), now: number = Date.now()): WorkspaceSnapshot<Organization, Line> | null {
  try {
    const raw = storage?.getItem(snapshotKey(userId)) ?? null;
    const snapshot = parseSnapshot<Organization, Line>(raw, userId, now);
    // Expired, damaged or from another version: it will never be shown, so it must not stay on the device.
    if (raw && !snapshot) storage?.removeItem(snapshotKey(userId));
    return snapshot;
  } catch { return null; }
}

/** Deletes every stored inbox that is not this user's: another account, or an older format. */
export function clearOtherWorkspaceSnapshots(userId: string, storage: SnapshotStorage | null = browserStorage()): void {
  try {
    if (!storage) return;
    const keep = snapshotKey(userId);
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith("onoff.workspace.") && key !== keep) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch { /* nothing more can be done */ }
}

export function saveWorkspaceSnapshot(snapshot: WorkspaceSnapshot<unknown, unknown>, storage: SnapshotStorage | null = browserStorage()): void {
  try { storage?.setItem(snapshotKey(snapshot.userId), JSON.stringify(snapshot)); } catch { /* storage full or blocked */ }
}

export function clearWorkspaceSnapshot(userId: string, storage: SnapshotStorage | null = browserStorage()): void {
  try { if (userId) storage?.removeItem(snapshotKey(userId)); } catch { /* nothing more can be done */ }
}

/** Identifies a snapshot's content, ignoring when it was written, to skip identical rewrites. */
export function snapshotSignature(snapshot: WorkspaceSnapshot<unknown, unknown>): string {
  const { savedAt: _savedAt, ...content } = snapshot;
  return JSON.stringify(content);
}
