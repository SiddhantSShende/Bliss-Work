/**
 * Pure logic behind "Add member" in a live call.
 *
 * The server mechanism is web's (packages/app useCall.tsx `addPeople`,
 * useCallRoom.ts `addPeople`): `POST /api/v1/calls/:id/participants` per person.
 * The server rings the newcomer (`call.ring`) and tells everyone already in the
 * call (`call.participant_added`). Nothing here touches React or the network
 * directly, so it is unit-tested.
 */

/** Someone to add. `name` is only for messages. */
export interface Invitee {
  id: string;
  name: string;
}

export interface AddFailure extends Invitee {
  message: string;
}

export interface AddPeopleOutcome {
  added: Invitee[];
  failed: AddFailure[];
  /** A 1:1 call was widened: this device moved from peer-to-peer to the room. */
  movedToRoom: boolean;
}

export type AddProgress = { done: number; total: number; current?: Invitee };

/** How long a person we just rang is shown as "Ringing" before we stop
 *  claiming it (matches the server-side ring window used by the rest of the app). */
export const INVITEE_RING_MS = 30_000;

interface ErrorLike {
  status?: number;
  message?: string;
}

/** The sentence to show for one failed add. Prefers something specific over
 *  "forbidden": the server answers 403 for several distinct reasons and
 *  deliberately does not say which (so a bystander learns nothing). */
export function describeAddFailure(e: unknown): string {
  const err = (e ?? {}) as ErrorLike;
  switch (err.status) {
    case 403:
      return "They can't be added to this call (they may not be in this channel, or a block applies)";
    case 404:
      return 'This call no longer exists';
    case 409:
    case 410:
      return 'This call has already ended';
    case 429:
      return 'Too many requests, try again in a moment';
    default:
      break;
  }
  const msg = typeof err.message === 'string' ? err.message.trim() : '';
  if (msg && msg.length < 140) return msg;
  return 'Could not reach the server';
}

/** Add people one after another (web does the same), never stopping at the first
 *  failure: everyone who can be added is added, and every failure is named. */
export async function addPeopleSequentially(
  people: readonly Invitee[],
  add: (userId: string) => Promise<unknown>,
  onProgress?: (p: AddProgress) => void,
): Promise<{ added: Invitee[]; failed: AddFailure[] }> {
  const added: Invitee[] = [];
  const failed: AddFailure[] = [];
  const seen = new Set<string>();
  const unique = people.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  for (let i = 0; i < unique.length; i++) {
    const p = unique[i]!;
    onProgress?.({ done: i, total: unique.length, current: p });
    try {
      await add(p.id);
      added.push(p);
    } catch (e) {
      failed.push({ ...p, message: describeAddFailure(e) });
    }
  }
  onProgress?.({ done: unique.length, total: unique.length });
  return { added, failed };
}

export interface OutcomeNotice {
  tone: 'success' | 'error' | 'mixed';
  text: string;
}

const list = (xs: readonly Invitee[]) =>
  xs.length <= 2 ? xs.map((x) => x.name).join(' and ') : `${xs[0]!.name} and ${xs.length - 1} others`;

/** One visible message for the whole batch (never silent, never a success toast
 *  that hides a failure). */
export function summarizeOutcome(o: AddPeopleOutcome): OutcomeNotice {
  if (o.failed.length === 0) {
    return { tone: 'success', text: o.added.length === 0 ? 'Nobody was added' : `Ringing ${list(o.added)}` };
  }
  const reasons = o.failed.map((f) => `${f.name}: ${f.message}`).join('\n');
  if (o.added.length === 0) {
    return { tone: 'error', text: `Couldn't add ${list(o.failed)}\n${reasons}` };
  }
  return { tone: 'mixed', text: `Ringing ${list(o.added)}. Couldn't add ${list(o.failed)}\n${reasons}` };
}

export interface PendingInvitee extends Invitee {
  at: number;
}

/** People we rang who have not turned up yet: still inside the ring window and
 *  not (yet) in the call's roster. `joinedIds` are LiveKit identities, which are
 *  BlissWork user ids. */
export function pendingInvitees(
  invited: readonly PendingInvitee[],
  joinedIds: readonly string[],
  now: number,
  ttl = INVITEE_RING_MS,
): PendingInvitee[] {
  const joined = new Set(joinedIds);
  return invited.filter((i) => !joined.has(i.id) && now - i.at < ttl);
}

/** Everyone who must not be offered in the picker again. */
export function alreadyInCallIds(
  joinedIds: readonly string[],
  invited: readonly Invitee[],
  extra: readonly (string | undefined)[] = [],
): string[] {
  const s = new Set<string>(joinedIds);
  for (const i of invited) s.add(i.id);
  for (const e of extra) if (e) s.add(e);
  return [...s];
}

export type BackAction = 'dismiss' | 'confirm-leave' | 'ignore';

/** What the hardware Back button does over the call UI. It must never end a live
 *  call silently: a finished call screen is dismissed, a live call asks first,
 *  and a ring is left alone (declining is an explicit button). */
export function backAction(directPhase: string, roomPhase: string): BackAction {
  if (directPhase === 'ended' || directPhase === 'rejected' || directPhase === 'failed') return 'dismiss';
  if (directPhase === 'idle' && (roomPhase === 'ended' || roomPhase === 'failed')) return 'dismiss';
  if (directPhase === 'incoming' || (directPhase === 'idle' && roomPhase === 'ringing')) return 'ignore';
  return 'confirm-leave';
}
