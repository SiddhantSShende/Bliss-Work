import type { UserDTO } from '@taskboard/shared';

export interface AddMembersResult {
  added: UserDTO[];
  /** Skipped because they were already in (or listed twice) — never sent, never duplicated. */
  skipped: UserDTO[];
  failed: { user: UserDTO; message: string }[];
}

/**
 * Adds members to a call/meeting one at a time through the backend's single-user
 * endpoint (`POST /calls/:id/participants`), collecting per-person failures
 * instead of stopping at the first. Anyone already present, or listed twice, is
 * skipped so nobody is added twice. The server stays the authority on who may add
 * whom (same-org, caller must be in the call, channel-membership and block rules);
 * its message is surfaced as-is.
 */
export async function addMembersToCall(
  add: (userId: string) => Promise<unknown>,
  users: readonly UserDTO[],
  alreadyIds: ReadonlySet<string>,
): Promise<AddMembersResult> {
  const result: AddMembersResult = { added: [], skipped: [], failed: [] };
  const seen = new Set(alreadyIds);
  for (const user of users) {
    if (seen.has(user.id)) {
      result.skipped.push(user);
      continue;
    }
    seen.add(user.id);
    try {
      await add(user.id);
      result.added.push(user);
    } catch (e) {
      result.failed.push({ user, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/** A one-line title/body for an Alert after adding members. */
export function describeAddResult(r: AddMembersResult): { title: string; body?: string } {
  const names = (us: readonly UserDTO[]) => us.map((u) => u.displayName).join(', ');
  if (r.failed.length === 0) {
    if (r.added.length === 0) return { title: 'Nobody new to add', body: r.skipped.length ? `${names(r.skipped)} already in.` : undefined };
    return { title: r.added.length === 1 ? `${r.added[0]!.displayName} added` : `${r.added.length} members added` };
  }
  const lines = r.failed.map((f) => `${f.user.displayName}: ${f.message}`).join('\n');
  if (r.added.length === 0) return { title: "Couldn't add members", body: lines };
  return { title: `Added ${r.added.length}, ${r.failed.length} failed`, body: lines };
}
