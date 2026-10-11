import { MAX_ADHOC_CALL_PARTICIPANTS, type CallDTO } from '@taskboard/shared';
import type { CallMedia } from './callController';

/**
 * The multi-select "Call": ONE ad-hoc call to several people at once.
 *
 * Not a meeting and not a call per person — the server makes a single DIRECT
 * call with no schedule (the same call a 1:1 becomes when somebody is added to
 * it) and rings everyone picked. We go straight into its room; they get the
 * incoming-call screen. Who may be called (same org, no blocks, the participant
 * limit) is the server's decision, and its refusal is shown as is.
 */

/** What a conference is called on screen and in the room — never "Meeting". */
export const CONFERENCE_TITLE = 'Conference call';

/** Two people, because one is just a 1:1 call and rings from the chat. */
export const MIN_CONFERENCE_PEOPLE = 2;
/** Everyone besides the caller. */
export const MAX_CONFERENCE_PEOPLE = MAX_ADHOC_CALL_PARTICIPANTS - 1;

/** Whether `count` picked people can be called together. */
export const canCallTogether = (count: number): boolean =>
  count >= MIN_CONFERENCE_PEOPLE && count <= MAX_CONFERENCE_PEOPLE;

export type ConferenceOutcome = { ok: true; callId: string } | { ok: false; message: string };

export interface ConferenceDeps {
  api: { startConferenceCall(peerIds: string[], media: CallMedia): Promise<CallDTO> };
  /** Already in a call — a second would leave the first running unattended. */
  busy: () => boolean;
  join: (callId: string, media: CallMedia, title: string) => void;
}

export async function startConferenceCall(
  d: ConferenceDeps,
  peerIds: readonly string[],
  media: CallMedia,
): Promise<ConferenceOutcome> {
  if (!canCallTogether(peerIds.length)) {
    return { ok: false, message: `Pick ${MIN_CONFERENCE_PEOPLE} to ${MAX_CONFERENCE_PEOPLE} people to call together` };
  }
  if (d.busy()) return { ok: false, message: 'You are already in a call' };
  try {
    const call = await d.api.startConferenceCall([...peerIds], media);
    d.join(call.id, media, CONFERENCE_TITLE);
    return { ok: true, callId: call.id };
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.message ? e.message : 'Please try again.' };
  }
}
