import type { ClientFrame, ControlFrame } from '@taskboard/shared';
import {
  CallController,
  type CallDeps,
  type CallMedia,
  type PeerMessage,
  type SessionLike,
  type SessionOpts,
} from '../callController';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';

class FakeSession implements SessionLike {
  localStream = { toURL: () => 'local', getVideoTracks: () => [] };
  remoteStream = { toURL: () => 'remote', getVideoTracks: () => [] };
  closed: string | undefined;
  mic = true;
  cam = false;
  switched = 0;
  sent: PeerMessage[] = [];
  offers: string[] = [];
  answers: string[] = [];
  ice: string[] = [];
  prepared = false;
  started = false;
  constructor(public o: SessionOpts) {}
  async prepareCallee() { this.prepared = true; }
  async startCaller() { this.started = true; }
  async onOffer(s: string) { this.offers.push(s); }
  async onAnswer(s: string) { this.answers.push(s); }
  async onIce(c: string) { this.ice.push(c); }
  toggleMic(on?: boolean) { this.mic = on ?? !this.mic; return this.mic; }
  async setCam(on?: boolean) { this.cam = on ?? !this.cam; return this.cam; }
  switchCamera() { this.switched++; }
  send(m: PeerMessage) { this.sent.push(m); }
  close(r?: string) { this.closed = r ?? 'ended'; }
}

function setup(over: Partial<CallDeps> = {}) {
  const frames: ClientFrame[] = [];
  let control: ((f: ControlFrame) => void) | undefined;
  const sessions: FakeSession[] = [];
  const events: string[] = [];
  const api = {
    turnCredentials: jest.fn(async () => ({ iceServers: [{ urls: ['turn:t'] }] })),
    startDirectCall: jest.fn(async () => ({ id: 'row-1' })),
    endCall: jest.fn(async () => undefined),
    leaveCall: jest.fn(async () => undefined),
    sendMessage: jest.fn(async () => undefined),
    callToken: jest.fn(async () => ({})),
    addCallParticipant: jest.fn(async (_c: string, _u: string) => ({})),
  };
  let n = 0;
  const deps: CallDeps = {
    rtc: {
      sendFrame: (f) => frames.push(f),
      onControl: (cb) => {
        control = cb;
        return () => { control = undefined; };
      },
    },
    api,
    selfId: () => ME,
    createSession: (o) => {
      const s = new FakeSession(o);
      sessions.push(s);
      return s;
    },
    newId: () => (n++ === 0 ? CALL : `call-${n}`),
    ensurePermissions: jest.fn(async () => true),
    onIncoming: (c) => events.push(`incoming:${c.callId}:${c.media}`),
    onIncomingDone: (id, why) => events.push(`done:${id}:${why}`),
    onMissed: (name) => events.push(`missed:${name}`),
    handoverMs: 0,
    ringMs: 50,
    connectMs: 50,
    reconnectMs: 50,
    lingerMs: 20,
    ...over,
  };
  const c = new CallController(deps);
  c.start();
  const recv = (f: ControlFrame) => control?.(f);
  const flush = () => new Promise((r) => setImmediate(r));
  const sent = (type: string) => frames.filter((f) => f.type === type);
  return { c, api, frames, sessions, events, recv, flush, sent, deps };
}

const invite = (media: CallMedia = 'audio'): ControlFrame => ({ type: 'call.invite', fromUserId: PEER, callId: CALL, media, fromName: 'Priya' });
const phase = (c: CallController) => c.getSnapshot().phase;

describe('outgoing call', () => {
  it('rings, connects after accept, and hangs up with call.end', async () => {
    const { c, sent, recv, flush, sessions, api } = setup();
    await c.invite(PEER, 'Priya', 'video');
    expect(phase(c)).toBe('outgoing');
    expect(sent('call.invite')).toEqual([{ type: 'call.invite', toUserId: PEER, callId: CALL, media: 'video' }]);
    await flush();
    expect(api.startDirectCall).toHaveBeenCalledWith(PEER, 'video');

    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    expect(phase(c)).toBe('connecting');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.started).toBe(true);

    sessions[0]!.o.onConnected();
    expect(phase(c)).toBe('connected');
    expect(c.getSnapshot().connectedAt).toBeGreaterThan(0);

    c.hangup();
    expect(sent('call.end')).toHaveLength(1);
    expect(phase(c)).toBe('idle');
    expect(sessions[0]!.closed).toBeDefined();
    expect(api.endCall).toHaveBeenCalledWith('row-1');
  });

  it('cancel while ringing sends call.cancel and records a missed call', async () => {
    const { c, sent, api, flush } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    await flush();
    c.hangup();
    expect(sent('call.cancel')).toHaveLength(1);
    expect(sent('call.end')).toHaveLength(0);
    expect(api.sendMessage).toHaveBeenCalledWith(PEER, 'Missed voice call', undefined, 'call_missed');
    expect(phase(c)).toBe('idle');
  });

  it('rings out to "No answer"', async () => {
    const { c, sent } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    await new Promise((r) => setTimeout(r, 60)); // ring is 50ms, linger 20ms
    expect(sent('call.cancel')).toHaveLength(1);
    expect(phase(c)).toBe('ended');
    expect(c.getSnapshot().reason).toBe('No answer');
  });

  it('peer decline -> rejected, then returns to idle by itself', async () => {
    const { c, recv } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    recv({ type: 'call.decline', fromUserId: PEER, callId: CALL });
    expect(phase(c)).toBe('rejected');
    await new Promise((r) => setTimeout(r, 40));
    expect(phase(c)).toBe('idle');
  });

  it('does not ring anyone when permissions are refused', async () => {
    const { c, sent } = setup({ ensurePermissions: jest.fn(async () => false) });
    await c.invite(PEER, 'Priya', 'video');
    expect(sent('call.invite')).toHaveLength(0);
    expect(phase(c)).toBe('failed');
  });

  it('peer unreachable ends the call', async () => {
    const { c, recv } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    recv({ type: 'rtc.peer.unreachable', offerId: CALL, reason: 'offline' });
    expect(phase(c)).toBe('ended');
    expect(c.getSnapshot().reason).toBe('User unavailable');
  });
});

describe('incoming call', () => {
  it('shows the ring with the caller name and notifies once', async () => {
    const { c, recv, events } = setup();
    recv(invite('video'));
    expect(phase(c)).toBe('incoming');
    expect(c.getSnapshot()).toMatchObject({ peerName: 'Priya', media: 'video', camOn: true });
    recv(invite('video')); // duplicate ring frame
    expect(events.filter((e) => e.startsWith('incoming'))).toHaveLength(1);
  });

  it('accept: prepares media, sends call.accept, connects from offer', async () => {
    const { c, recv, flush, sent, sessions, events } = setup();
    recv(invite('audio'));
    await c.accept();
    expect(sessions[0]!.prepared).toBe(true);
    expect(sent('call.accept')).toEqual([{ type: 'call.accept', toUserId: PEER, callId: CALL }]);
    expect(events).toContain(`done:${CALL}:answered`);
    recv({ type: 'rtc.offer', fromUserId: PEER, offerId: CALL, sdp: 'SDP' });
    recv({ type: 'rtc.ice', fromUserId: PEER, offerId: CALL, candidate: 'C1' });
    await flush();
    expect(sessions[0]!.offers).toEqual(['SDP']);
    expect(sessions[0]!.ice).toEqual(['C1']);
    sessions[0]!.o.onConnected();
    expect(phase(c)).toBe('connected');
  });

  it('decline sends call.decline and dismisses the notification', () => {
    const { c, recv, sent, events } = setup();
    recv(invite());
    c.decline();
    expect(sent('call.decline')).toEqual([{ type: 'call.decline', toUserId: PEER, callId: CALL }]);
    expect(phase(c)).toBe('idle');
    expect(events).toContain(`done:${CALL}:declined`);
    expect(events.filter((e) => e.startsWith('done'))).toHaveLength(1);
  });

  it('caller cancels before answer: missed call, ring dismissed', () => {
    const { c, recv, events } = setup();
    recv(invite());
    recv({ type: 'call.cancel', fromUserId: PEER, callId: CALL });
    expect(phase(c)).toBe('idle');
    expect(events).toEqual([`incoming:${CALL}:audio`, 'missed:Priya', `done:${CALL}:cancelled`]);
  });

  it('unanswered ring times out as a missed call', async () => {
    const { c, recv, events } = setup();
    recv(invite());
    await new Promise((r) => setTimeout(r, 80));
    expect(phase(c)).toBe('idle');
    expect(events).toContain('missed:Priya');
    expect(events).toContain(`done:${CALL}:timeout`);
  });

  it('auto-declines a second caller while busy', async () => {
    const { c, recv, sent } = setup();
    recv(invite());
    recv({ type: 'call.invite', fromUserId: 'other', callId: 'c2', media: 'audio' } as ControlFrame);
    expect(sent('call.decline')).toEqual([{ type: 'call.decline', toUserId: 'other', callId: 'c2' }]);
    expect(phase(c)).toBe('incoming');
    expect(c.getSnapshot().callId).toBe(CALL);
  });

  it('cancel arriving during accept does not create a session or call.accept', async () => {
    const { c, recv, sent, sessions } = setup({ ensurePermissions: () => new Promise((r) => setTimeout(() => r(true), 10)) });
    recv(invite());
    const p = c.accept();
    recv({ type: 'call.cancel', fromUserId: PEER, callId: CALL });
    await p;
    expect(sent('call.accept')).toHaveLength(0);
    expect(sessions).toHaveLength(0);
    expect(phase(c)).toBe('idle');
  });
});

describe('connection state', () => {
  async function connected() {
    const t = setup();
    await t.c.invite(PEER, 'Priya', 'audio');
    t.recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await t.flush();
    t.sessions[0]!.o.onConnected();
    return t;
  }

  it('shows reconnecting on a transient drop and recovers', async () => {
    const { c, sessions } = await connected();
    sessions[0]!.o.onConnectionState('disconnected');
    expect(phase(c)).toBe('reconnecting');
    sessions[0]!.o.onConnectionState('connected');
    expect(phase(c)).toBe('connected');
  });

  it('a drop that never recovers becomes FAILED, and Retry rings again', async () => {
    const { c, sessions, sent } = await connected();
    sessions[0]!.o.onConnectionState('disconnected');
    await new Promise((r) => setTimeout(r, 80));
    expect(phase(c)).toBe('failed');
    expect(c.getSnapshot().reason).toBe('Call connection failed');
    expect(c.getSnapshot().peerId).toBe(PEER);
    await c.retry();
    expect(phase(c)).toBe('outgoing');
    expect(sent('call.invite')).toHaveLength(2);
  });

  it('a failed peer connection surfaces as FAILED, not a silent end', async () => {
    const { c, sessions } = await connected();
    sessions[0]!.o.onClosed('connection failed');
    expect(phase(c)).toBe('failed');
  });

  it('never connecting within the timeout is FAILED', async () => {
    const { c, recv, flush } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    await new Promise((r) => setTimeout(r, 80));
    expect(phase(c)).toBe('failed');
  });

  it('End from the failed screen returns to idle', async () => {
    const { c, sessions } = await connected();
    sessions[0]!.o.onClosed('connection failed');
    c.hangup();
    expect(phase(c)).toBe('idle');
  });

  it('remote hangup -> ended then idle', async () => {
    const { c, recv } = await connected();
    recv({ type: 'call.end', fromUserId: PEER, callId: CALL });
    expect(phase(c)).toBe('ended');
    await new Promise((r) => setTimeout(r, 40));
    expect(phase(c)).toBe('idle');
  });
});

describe('controls', () => {
  it('mic, camera, switch camera and speaker act on the session/audio route', async () => {
    const applySpeaker = jest.fn();
    const { c, recv, flush, sessions } = setup({ applySpeaker });
    await c.invite(PEER, 'Priya', 'video');
    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    const s = sessions[0]!;
    c.toggleMic();
    expect(s.mic).toBe(false);
    expect(c.getSnapshot().micOn).toBe(false);
    expect(c.getSnapshot().camOn).toBe(true); // a video call starts with the camera on
    await c.switchCamera();
    expect(s.switched).toBe(1);
    await c.toggleCam();
    expect(s.cam).toBe(false);
    expect(c.getSnapshot().camOn).toBe(false);
    await c.switchCamera();
    expect(s.switched).toBe(1); // camera off: nothing to flip
    c.toggleSpeaker();
    expect(applySpeaker).toHaveBeenCalledWith(true);
    expect(c.getSnapshot().speakerOn).toBe(true);
  });

  it('camera on mid voice call asks for camera permission and stays off if refused', async () => {
    const ensureCamera = jest.fn(async () => false);
    const { c, recv, flush, sessions } = setup({ ensureCamera });
    await c.invite(PEER, 'Priya', 'audio');
    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    await c.toggleCam();
    expect(ensureCamera).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.cam).toBe(false);
    expect(c.getSnapshot().camOn).toBe(false);
  });

  it('peer camera state and record hand-off arrive over the data channel', async () => {
    const { c, recv, flush, sessions } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    await flush();
    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    sessions[0]!.o.onPeerMessage({ t: 'state', mic: true, cam: true, sharing: false });
    expect(c.getSnapshot().peerCamOn).toBe(true);
    sessions[0]!.o.onMetaOpen();
    expect(sessions[0]!.sent).toContainEqual({ t: 'record', callId: 'row-1' });
  });

  it('being moved to the room hands over without ending the call row', async () => {
    const onEnterRoom = jest.fn();
    const { c, recv, flush, sessions, api } = setup({ onEnterRoom });
    await c.invite(PEER, 'Priya', 'audio');
    await flush();
    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    sessions[0]!.o.onPeerMessage({ t: 'room', callId: 'room-9' });
    expect(onEnterRoom).toHaveBeenCalledWith('room-9', 'audio');
    expect(phase(c)).toBe('idle');
    expect(api.endCall).not.toHaveBeenCalled();
  });
});

describe('state does not leak between calls', () => {
  it('a new call starts with no old streams, timer start, or reason', async () => {
    const { c, recv, flush, sessions } = setup();
    await c.invite(PEER, 'Priya', 'video');
    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    sessions[0]!.o.onConnected();
    sessions[0]!.o.onRemoteStream(sessions[0]!.remoteStream);
    sessions[0]!.o.onPeerMessage({ t: 'state', mic: true, cam: true, sharing: false });
    expect(c.getSnapshot().connectedAt).toBeDefined();
    expect(c.getSnapshot().remoteStream).toBeDefined();
    c.hangup();
    // Even a late event from the CLOSED session must not resurrect anything.
    sessions[0]!.o.onRemoteStream(sessions[0]!.remoteStream);
    expect(c.getSnapshot()).toMatchObject({ phase: 'idle', connectedAt: undefined, localStream: undefined, remoteStream: undefined, reason: undefined, peerCamOn: false, callId: undefined });

    await c.invite(PEER, 'Priya', 'audio');
    expect(c.getSnapshot()).toMatchObject({ phase: 'outgoing', connectedAt: undefined, localStream: undefined, remoteStream: undefined, camOn: false });
  });

  it('an ended call leaves no stream behind for the next ring', async () => {
    const { c, recv, flush, sessions } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    sessions[0]!.o.onConnected();
    recv({ type: 'call.end', fromUserId: PEER, callId: CALL });
    expect(c.getSnapshot().remoteStream).toBeUndefined();
    await new Promise((r) => setTimeout(r, 40));
    recv({ type: 'call.invite', fromUserId: PEER, callId: 'c-2', media: 'audio', fromName: 'Priya' } as never);
    expect(c.getSnapshot()).toMatchObject({ phase: 'incoming', connectedAt: undefined, remoteStream: undefined, localStream: undefined });
  });
});

describe('wire contract (frames exactly as ws-gateway emits them)', () => {
  // services/ws-gateway signal.Frame marshals: type, fromUserId, callId, media,
  // fromName; toUserId is stripped. Parsed by the same schema WsClient uses, so
  // a frame the client would drop as "unrecognized" fails here.
  it('a gateway call.invite parses as a ControlFrame and rings', () => {
    const { ControlFrame } = require('@taskboard/shared') as typeof import('@taskboard/shared');
    const raw = JSON.parse(`{"type":"call.invite","fromUserId":"${PEER}","callId":"${CALL}","media":"video","fromName":"priya@acme.io"}`);
    const parsed = ControlFrame.safeParse(raw);
    expect(parsed.success).toBe(true);
    const { c, recv, events } = setup();
    recv(parsed.data!);
    expect(c.getSnapshot()).toMatchObject({ phase: 'incoming', callId: CALL, peerId: PEER, media: 'video', peerName: 'priya@acme.io' });
    expect(events).toContain(`incoming:${CALL}:video`);
  });

  it('a gateway rtc.peer.unreachable for a ring ends the outgoing call', async () => {
    const { ControlFrame } = require('@taskboard/shared') as typeof import('@taskboard/shared');
    const parsed = ControlFrame.safeParse({ type: 'rtc.peer.unreachable', offerId: CALL, reason: 'offline' });
    expect(parsed.success).toBe(true);
    const { c, recv } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    recv(parsed.data!);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ended', reason: 'User unavailable' });
  });
});

describe('ring handling edge cases', () => {
  it('the same ring delivered twice is one ring, not a second caller to decline', () => {
    const { c, recv, sent, events } = setup();
    recv(invite());
    recv(invite());
    expect(sent('call.decline')).toHaveLength(0);
    expect(phase(c)).toBe('incoming');
    expect(events.filter((e) => e.startsWith('incoming:'))).toHaveLength(1);
  });

  it('is declined as busy while a room call holds the microphone', () => {
    const { c, recv, sent } = setup({ isBusy: () => true });
    recv(invite());
    expect(sent('call.decline')).toHaveLength(1);
    expect(phase(c)).toBe('idle');
  });

  it('a ring arriving while the previous call\'s "ended" screen lingers is not turned away', async () => {
    const { c, recv, flush, sessions, sent } = setup({ lingerMs: 1000 });
    await c.invite(PEER, 'Priya', 'audio');
    recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await flush();
    sessions[0]!.o.onConnected();
    recv({ type: 'call.end', fromUserId: PEER, callId: CALL });
    expect(phase(c)).toBe('ended');
    recv({ type: 'call.invite', fromUserId: PEER, callId: 'c-2', media: 'audio', fromName: 'Priya' } as never);
    expect(sent('call.decline')).toHaveLength(0);
    expect(phase(c)).toBe('incoming');
    c.dispose();
  });

  it('disposing while an invite is still ringing silences the ring', () => {
    const { c, recv, events } = setup();
    recv({ type: 'call.invite', fromUserId: PEER, callId: 'c-9', media: 'audio', fromName: 'Priya' } as never);
    expect(phase(c)).toBe('incoming');
    c.dispose();
    expect(events).toContain('done:c-9:cancelled');
  });

  it('a new outgoing call can start while the ended screen lingers', async () => {
    const { c, recv, flush, sessions } = setup({ lingerMs: 1000 });
    await c.invite(PEER, 'Priya', 'audio');
    recv({ type: 'call.decline', fromUserId: PEER, callId: CALL });
    await flush();
    expect(phase(c)).toBe('rejected');
    await c.invite(PEER, 'Priya', 'audio');
    expect(phase(c)).toBe('outgoing');
    expect(sessions).toHaveLength(0);
    c.dispose();
  });

  it('forced speaker re-applies the route even when the snapshot already says so', () => {
    const applySpeaker = jest.fn();
    const { c } = setup({ applySpeaker });
    c.setSpeaker(true);
    c.setSpeaker(true);
    expect(applySpeaker).toHaveBeenCalledTimes(1);
    c.setSpeaker(true, true);
    expect(applySpeaker).toHaveBeenCalledTimes(2);
  });
});

describe('Add member to a live 1:1 call (web useCall.addPeople)', () => {
  const PEOPLE = [
    { id: 'u-3', name: 'Sam' },
    { id: 'u-4', name: 'Lee' },
  ];
  async function connectedCall(over: Partial<CallDeps> = {}) {
    const t = setup(over);
    await t.c.invite(PEER, 'Priya', 'audio');
    await t.flush();
    t.recv({ type: 'call.accept', fromUserId: PEER, callId: CALL });
    await t.flush();
    t.sessions[0]!.o.onConnected();
    return t;
  }

  it('exposes the call row id once the server row exists (caller) so the UI can enable the button', async () => {
    const { c } = await connectedCall();
    expect(c.getSnapshot().recordId).toBe('row-1');
  });

  it('the callee learns the row id over the data channel', async () => {
    const { c, recv, flush, sessions } = setup();
    recv(invite('audio'));
    await c.accept();
    await flush();
    sessions[0]!.o.onConnected();
    expect(c.getSnapshot().recordId).toBeUndefined();
    sessions[0]!.o.onPeerMessage({ t: 'record', callId: 'row-7' });
    expect(c.getSnapshot().recordId).toBe('row-7');
  });

  it('checks the room, adds each person, tells the peer, and moves this end to the room', async () => {
    const onEnterRoom = jest.fn();
    const { c, api, sessions } = await connectedCall({ onEnterRoom });
    const order: string[] = [];
    api.callToken.mockImplementation(async () => { order.push('token'); return {}; });
    api.addCallParticipant.mockImplementation(async (_: string, id: string) => { order.push(`add:${id}`); return {}; });
    const s = sessions[0]!;
    const send = s.send.bind(s);
    s.send = (m) => { order.push(`send:${m.t}`); send(m); };
    const out = await c.addPeople(PEOPLE);
    expect(order).toEqual(['token', 'add:u-3', 'add:u-4', 'send:room']);
    expect(api.addCallParticipant).toHaveBeenCalledWith('row-1', 'u-3');
    expect(s.sent).toContainEqual({ t: 'room', callId: 'row-1' });
    expect(out).toEqual({ added: PEOPLE, failed: [], movedToRoom: true });
    expect(onEnterRoom).toHaveBeenCalledWith('row-1', 'audio');
    expect(s.closed).toBe('moved to the room');
    expect(phase(c)).toBe('idle');
    // The row now belongs to the room: it must not be ended by the hand-over.
    expect(api.endCall).not.toHaveBeenCalled();
  });

  it('adds nobody when the room is unreachable, and stays on the P2P call', async () => {
    const onEnterRoom = jest.fn();
    const { c, api } = await connectedCall({ onEnterRoom });
    api.callToken.mockRejectedValue(new Error('no sfu'));
    const out = await c.addPeople(PEOPLE);
    expect(api.addCallParticipant).not.toHaveBeenCalled();
    expect(out.added).toEqual([]);
    expect(out.failed).toHaveLength(2);
    expect(out.failed[0]!.message).toMatch(/not available/);
    expect(out.movedToRoom).toBe(false);
    expect(onEnterRoom).not.toHaveBeenCalled();
    expect(phase(c)).toBe('connected');
  });

  it('a failed person is reported, the rest are still added and the call widens', async () => {
    const onEnterRoom = jest.fn();
    const { c, api } = await connectedCall({ onEnterRoom });
    api.addCallParticipant.mockImplementation(async (_: string, id: string) => {
      if (id === 'u-3') throw Object.assign(new Error('forbidden'), { status: 403 });
      return {};
    });
    const out = await c.addPeople(PEOPLE);
    expect(out.added.map((p) => p.id)).toEqual(['u-4']);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]!.name).toBe('Sam');
    expect(out.failed[0]!.message).toMatch(/can't be added/);
    expect(out.movedToRoom).toBe(true);
    expect(onEnterRoom).toHaveBeenCalledTimes(1);
  });

  it('when everyone fails the call stays peer-to-peer', async () => {
    const onEnterRoom = jest.fn();
    const { c, api, sessions } = await connectedCall({ onEnterRoom });
    api.addCallParticipant.mockRejectedValue(Object.assign(new Error('x'), { status: 403 }));
    const out = await c.addPeople(PEOPLE);
    expect(out.movedToRoom).toBe(false);
    expect(sessions[0]!.sent.some((m) => m.t === 'room')).toBe(false);
    expect(onEnterRoom).not.toHaveBeenCalled();
    expect(phase(c)).toBe('connected');
  });

  it('refuses (visibly) before the call is connected or has a row', async () => {
    const { c, api } = setup();
    await c.invite(PEER, 'Priya', 'audio');
    const out = await c.addPeople(PEOPLE);
    expect(out.failed).toHaveLength(2);
    expect(api.callToken).not.toHaveBeenCalled();
  });

  it('does not enter the room if the peer hung up while people were being added', async () => {
    const onEnterRoom = jest.fn();
    const { c, api, recv } = await connectedCall({ onEnterRoom });
    api.addCallParticipant.mockImplementation(async () => {
      recv({ type: 'call.end', fromUserId: PEER, callId: CALL });
      return {};
    });
    const out = await c.addPeople(PEOPLE);
    expect(out.movedToRoom).toBe(false);
    expect(onEnterRoom).not.toHaveBeenCalled();
  });
});
