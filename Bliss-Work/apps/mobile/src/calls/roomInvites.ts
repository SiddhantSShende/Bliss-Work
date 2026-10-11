import { EventType, isAdhocCall, type ServerEvent } from '@taskboard/shared';
import { CONFERENCE_TITLE } from './conferenceCall';
import type { CallMedia } from './callController';

/**
 * Which server call events ring a phone, and which dismiss a ring.
 *
 * Pure so it can be unit-tested against payloads shaped exactly like
 * messaging-svc emits them (see EmitCallLifecycle / calls.go):
 *
 * - "Call now" in a CHANNEL, and "Meet now" for a MEETING, create the call row
 *   already LIVE and emit ONLY `call.scheduled` (status LIVE) to the roster —
 *   never `call.started` (that is fired by POST /calls/:id/start, i.e. only
 *   for calls that were scheduled for later) and never `call.ring`. A client
 *   that listens for started/ring alone is never told a channel call exists.
 * - `call.ring` is sent to ONE person, only by "add participant"; the same
 *   request then sends `call.participant_added` to the whole roster, INCLUDING
 *   the person just rung. `actorId` on that event is whoever did the adding,
 *   so it must not be read as "you already answered".
 * - An immediate 1:1 call is NOT announced by any event (the WS `call.invite`
 *   frame is the ring); only a call scheduled for later raises `call.scheduled`.
 */

export type RoomInviteDecision =
  | {
      kind: 'announce';
      callId: string;
      title: string;
      media: CallMedia;
      actorId?: string;
      /** A 1:1 call's row also raises these events on top of the WS ring that
       *  already reached us; the caller waits a moment and checks. */
      directDuplicate: boolean;
      /** An ad-hoc call we were added to: a call, never worded as a meeting. */
      adhoc: boolean;
    }
  | { kind: 'dismiss'; callId: string }
  | null;

export function roomInviteFor(e: ServerEvent, ctx: { me?: string; replayed: boolean }): RoomInviteDecision {
  switch (e.type) {
    case EventType.CallRing:
    case EventType.CallStarted:
    case EventType.CallWaiting:
    case EventType.CallScheduled: {
      // Catch-up from before this socket existed is not news, and our own
      // action (or the same action on our other device) is not an invite.
      if (ctx.replayed || (ctx.me && e.actorId === ctx.me)) return null;
      // A call scheduled for later is an appointment, not a ring. Only one
      // that is live right now, and that has a group to ring, is an invite.
      if (e.type === EventType.CallScheduled && (e.status !== 'LIVE' || e.kind === 'DIRECT')) return null;
      return {
        kind: 'announce',
        callId: e.callId,
        // An ad-hoc call somebody was added to is a call, not a meeting.
        title: e.title || (isAdhocCall(e) ? CONFERENCE_TITLE : e.kind === 'CHANNEL' ? 'Channel call' : 'Meeting'),
        media: e.media ?? 'video',
        actorId: e.actorId,
        directDuplicate: e.kind === 'DIRECT',
        adhoc: isAdhocCall(e),
      };
    }
    case EventType.CallEnded:
      return { kind: 'dismiss', callId: e.callId };
    case EventType.CallParticipantAdded:
      // Answered on another device of ours: the actor is us. When someone ELSE
      // added us, this event arrives right behind the ring meant for us and
      // must not cancel it.
      return ctx.me && e.actorId === ctx.me ? { kind: 'dismiss', callId: e.callId } : null;
    default:
      return null;
  }
}
