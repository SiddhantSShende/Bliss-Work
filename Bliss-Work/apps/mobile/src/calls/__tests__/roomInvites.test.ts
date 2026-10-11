import { ServerEvent } from '@taskboard/shared';
import { roomInviteFor } from '../roomInvites';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';
const CHAN = '44444444-4444-4444-8444-444444444444';
const ORG = '55555555-5555-4555-8555-555555555555';

/** Shaped like messaging-svc's events.CallLifecycle JSON, parsed by the SAME
 *  zod schema the websocket client uses — so a payload the client would drop
 *  fails here instead of on a phone. */
function evt(type: string, over: Record<string, unknown> = {}): ServerEvent {
  const parsed = ServerEvent.safeParse({
    type,
    eventId: '66666666-6666-4666-8666-666666666666',
    orgId: ORG,
    occurredAt: '2026-01-01T10:00:00.000Z',
    callId: CALL,
    kind: 'CHANNEL',
    channelId: CHAN,
    title: 'general',
    media: 'video',
    status: 'LIVE',
    actorId: OTHER,
    members: [ME, OTHER],
    ...over,
  });
  if (!parsed.success) throw new Error(`payload rejected by the client schema: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
}

const live = { me: ME, replayed: false };

describe('which call events ring a phone', () => {
  it('rings for a channel call started now (only call.scheduled LIVE is sent, never call.started)', () => {
    expect(roomInviteFor(evt('call.scheduled'), live)).toEqual({
      kind: 'announce',
      callId: CALL,
      title: 'general',
      media: 'video',
      actorId: OTHER,
      directDuplicate: false,
      adhoc: false,
    });
  });

  it('rings for a meeting started now, with a fallback title', () => {
    const d = roomInviteFor(evt('call.scheduled', { kind: 'MEETING', channelId: undefined, title: undefined }), live);
    expect(d).toMatchObject({ kind: 'announce', title: 'Meeting' });
  });

  it('does not ring for a call scheduled for later', () => {
    expect(roomInviteFor(evt('call.scheduled', { status: 'SCHEDULED', scheduledAt: '2026-01-02T10:00:00.000Z' }), live)).toBeNull();
  });

  it('does not ring for a 1:1 call row (the WS invite frame is the ring)', () => {
    expect(roomInviteFor(evt('call.scheduled', { kind: 'DIRECT' }), live)).toBeNull();
  });

  it('rings when the host starts a scheduled call, and when we are added to one', () => {
    expect(roomInviteFor(evt('call.started', { kind: 'MEETING' }), live)).toMatchObject({ kind: 'announce' });
    expect(roomInviteFor(evt('call.ring', { kind: 'MEETING' }), live)).toMatchObject({ kind: 'announce' });
  });

  it('marks a DIRECT started/ring as a possible duplicate of the WS ring', () => {
    expect(roomInviteFor(evt('call.ring', { kind: 'DIRECT' }), live)).toMatchObject({ directDuplicate: true });
  });

  it('never rings for replayed catch-up or for our own action', () => {
    expect(roomInviteFor(evt('call.scheduled'), { me: ME, replayed: true })).toBeNull();
    expect(roomInviteFor(evt('call.scheduled', { actorId: ME }), live)).toBeNull();
  });
});

describe('being added to an ad-hoc call (a 1:1 that grew into a conference)', () => {
  const adhoc = (over: Record<string, unknown> = {}) =>
    evt('call.ring', { kind: 'DIRECT', channelId: undefined, title: undefined, scheduledAt: undefined, ...over });

  it('rings as a CALL, not a meeting: titled as a conference call and flagged ad-hoc', () => {
    expect(roomInviteFor(adhoc(), live)).toEqual({
      kind: 'announce',
      callId: CALL,
      title: 'Conference call',
      media: 'video',
      actorId: OTHER,
      directDuplicate: true,
      adhoc: true,
    });
  });

  it('a titled ad-hoc call keeps its title and is still ad-hoc', () => {
    expect(roomInviteFor(adhoc({ title: 'Quick sync' }), live)).toMatchObject({ title: 'Quick sync', adhoc: true });
  });

  it('a DIRECT call that was scheduled, a meeting and a channel call are none of them ad-hoc', () => {
    expect(roomInviteFor(adhoc({ scheduledAt: '2026-01-02T10:00:00.000Z' }), live)).toMatchObject({ adhoc: false });
    expect(roomInviteFor(evt('call.ring', { kind: 'MEETING', title: undefined }), live)).toMatchObject({
      adhoc: false,
      title: 'Meeting',
    });
    expect(roomInviteFor(evt('call.ring', { kind: 'CHANNEL' }), live)).toMatchObject({ adhoc: false, title: 'general' });
  });

  it('is not cancelled by the participant_added that follows the ring to the whole room', () => {
    expect(roomInviteFor(evt('call.participant_added', { kind: 'DIRECT', actorId: OTHER }), live)).toBeNull();
  });
});

describe('which call events dismiss a ring', () => {
  it('the call ended', () => {
    expect(roomInviteFor(evt('call.ended'), live)).toEqual({ kind: 'dismiss', callId: CALL });
  });

  it('answered on another device of ours (we are the actor)', () => {
    expect(roomInviteFor(evt('call.participant_added', { actorId: ME }), live)).toEqual({ kind: 'dismiss', callId: CALL });
  });

  it('someone adding US sends participant_added right behind the ring: it must not cancel it', () => {
    expect(roomInviteFor(evt('call.participant_added', { actorId: OTHER }), live)).toBeNull();
  });
});
