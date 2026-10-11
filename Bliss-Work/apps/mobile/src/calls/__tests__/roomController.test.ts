import type { CallJoinDTO } from '@taskboard/shared';
import { RoomController, type RoomDeps, type RoomLike, type RoomParticipantView } from '../roomController';

const CALL = '44444444-4444-4444-8444-444444444444';

class FakeRoom implements RoomLike {
  cbs = { change: [] as (() => void)[], reconnecting: [] as (() => void)[], reconnected: [] as (() => void)[], disconnected: [] as ((r?: string) => void)[] };
  connected: { url: string; token: string } | undefined;
  mic = false;
  cam = false;
  switched = 0;
  disconnects = 0;
  people: RoomParticipantView[] = [{ identity: 'me', name: 'Me', isLocal: true, speaking: false, micOn: true, camOn: false }];
  failConnect = false;
  async connect(url: string, token: string) {
    if (this.failConnect) throw new Error('boom');
    this.connected = { url, token };
  }
  async disconnect() { this.disconnects++; }
  async setMic(on: boolean) { this.mic = on; }
  async setCam(on: boolean) { this.cam = on; }
  switchCamera() { this.switched++; }
  participants() { return this.people; }
  onChange(cb: () => void) { this.cbs.change.push(cb); return () => {}; }
  onReconnecting(cb: () => void) { this.cbs.reconnecting.push(cb); return () => {}; }
  onReconnected(cb: () => void) { this.cbs.reconnected.push(cb); return () => {}; }
  onDisconnected(cb: (r?: string) => void) { this.cbs.disconnected.push(cb); return () => {}; }
}

const JOINED: CallJoinDTO = { state: 'JOINED', url: 'wss://sfu', token: 'T', room: 'r', identity: 'me', expiresAt: 'x', role: 'PARTICIPANT' };
const WAITING = (canStart: boolean): CallJoinDTO => ({ state: 'WAITING', callId: CALL, status: 'SCHEDULED', canStart });

function setup(tokens: (CallJoinDTO | Error)[], over: Partial<RoomDeps> = {}) {
  const rooms: FakeRoom[] = [];
  const events: string[] = [];
  let cb: ((e: { type: 'started' | 'ended'; callId: string }) => void) | undefined;
  let i = 0;
  const api = {
    callToken: jest.fn(async () => {
      const t = tokens[Math.min(i++, tokens.length - 1)]!;
      if (t instanceof Error) throw t;
      return t;
    }),
    startCall: jest.fn(async () => ({}) as never),
    leaveCall: jest.fn(async () => undefined),
    endCall: jest.fn(async () => undefined),
    addCallParticipant: jest.fn(async (_c: string, _u: string) => ({})),
  };
  const deps: RoomDeps = {
    api,
    createRoom: () => { const r = new FakeRoom(); rooms.push(r); return r; },
    onCallEvent: (f) => { cb = f; return () => { cb = undefined; }; },
    ensurePermissions: jest.fn(async () => true),
    onRinging: (c) => events.push(`ring:${c.callId}`),
    onRingingDone: (id, why) => events.push(`done:${id}:${why}`),
    ringMs: 40, lobbyPollMs: 1000, accessCheckMs: 30, lingerMs: 20,
    ...over,
  };
  const c = new RoomController(deps);
  return { c, api, rooms, events, emit: (e: { type: 'started' | 'ended'; callId: string }) => cb?.(e), deps };
}
const phase = (c: RoomController) => c.getSnapshot().phase;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('room call', () => {
  it('joins with the minted token, publishes mic (+cam for video), and connects', async () => {
    const { c, rooms, api } = setup([JOINED]);
    await c.join(CALL, 'video', 'Standup');
    expect(api.callToken).toHaveBeenCalledWith(CALL);
    expect(rooms[0]!.connected).toEqual({ url: 'wss://sfu', token: 'T' });
    expect(rooms[0]!.mic).toBe(true);
    expect(rooms[0]!.cam).toBe(true);
    expect(phase(c)).toBe('connected');
    expect(c.getSnapshot().participants).toHaveLength(1);
    expect(c.getSnapshot().title).toBe('Standup');
  });

  it('a voice join does not publish the camera', async () => {
    const { c, rooms } = setup([JOINED]);
    await c.join(CALL, 'audio');
    expect(rooms[0]!.cam).toBe(false);
    expect(c.getSnapshot().camOn).toBe(false);
  });

  it('waiting room: joins when call.started arrives, without opening a room before', async () => {
    const { c, rooms, emit } = setup([WAITING(false), JOINED]);
    await c.join(CALL, 'video');
    expect(phase(c)).toBe('waiting');
    expect(c.getSnapshot().canStart).toBe(false);
    expect(rooms).toHaveLength(0);
    emit({ type: 'started', callId: CALL });
    await tick(5);
    expect(phase(c)).toBe('connected');
    expect(rooms).toHaveLength(1);
  });

  it('host in the waiting room can start the call', async () => {
    const { c, api } = setup([WAITING(true), JOINED]);
    await c.join(CALL, 'video');
    expect(c.getSnapshot().canStart).toBe(true);
    await c.startNow();
    await tick(5);
    expect(api.startCall).toHaveBeenCalledWith(CALL);
    expect(phase(c)).toBe('connected');
  });

  it('non-host cannot start', async () => {
    const { c, api } = setup([WAITING(false)]);
    await c.join(CALL, 'video');
    await c.startNow();
    expect(api.startCall).not.toHaveBeenCalled();
  });

  it('refused permissions never touch the network', async () => {
    const { c, api } = setup([JOINED], { ensurePermissions: jest.fn(async () => false) });
    await c.join(CALL, 'video');
    expect(api.callToken).not.toHaveBeenCalled();
    expect(phase(c)).toBe('failed');
  });

  it('token failure -> failed, and Retry joins again', async () => {
    const { c, api } = setup([new Error('net'), JOINED]);
    await c.join(CALL, 'video');
    expect(phase(c)).toBe('failed');
    expect(c.getSnapshot().reason).toBe('Call connection failed');
    c.retry();
    await tick(5);
    expect(phase(c)).toBe('connected');
    expect(api.callToken).toHaveBeenCalledTimes(2);
  });

  it('SFU connect failure -> failed', async () => {
    const t = setup([JOINED], { createRoom: () => { const r = new FakeRoom(); r.failConnect = true; return r; } });
    await t.c.join(CALL, 'video');
    expect(phase(t.c)).toBe('failed');
  });

  it('shows reconnecting then recovers', async () => {
    const { c, rooms } = setup([JOINED]);
    await c.join(CALL, 'video');
    rooms[0]!.cbs.reconnecting.forEach((f) => f());
    expect(phase(c)).toBe('reconnecting');
    rooms[0]!.cbs.reconnected.forEach((f) => f());
    expect(phase(c)).toBe('connected');
  });

  it('SFU disconnect becomes a visible failure, not a silent close', async () => {
    const { c, rooms } = setup([JOINED]);
    await c.join(CALL, 'video');
    rooms[0]!.cbs.disconnected.forEach((f) => f());
    expect(phase(c)).toBe('failed');
  });

  it('call.ended closes the room without a second leave request', async () => {
    const { c, api, emit, rooms } = setup([JOINED]);
    await c.join(CALL, 'video');
    emit({ type: 'ended', callId: CALL });
    expect(phase(c)).toBe('ended');
    expect(rooms[0]!.disconnects).toBe(1);
    expect(api.leaveCall).not.toHaveBeenCalled();
    await tick(40);
    expect(phase(c)).toBe('idle');
  });

  it('leave disconnects and reports the departure once', async () => {
    const { c, api, rooms } = setup([JOINED]);
    await c.join(CALL, 'video');
    c.leave();
    expect(phase(c)).toBe('idle');
    expect(rooms[0]!.disconnects).toBe(1);
    expect(api.leaveCall).toHaveBeenCalledTimes(1);
  });

  it('leaving while the token request is in flight does not land in the room', async () => {
    let release!: (v: CallJoinDTO) => void;
    const t = setup([JOINED]);
    t.api.callToken.mockImplementation(() => new Promise((r) => { release = r; }));
    const p = t.c.join(CALL, 'video');
    await tick(1);
    t.c.leave();
    release(JOINED);
    await p;
    await tick(5);
    expect(phase(t.c)).toBe('idle');
    expect(t.rooms).toHaveLength(0);
    expect(t.api.leaveCall).toHaveBeenCalled();
  });

  it('host end-for-all ends the call server-side', async () => {
    const { c, api } = setup([{ ...JOINED, role: 'HOST' }]);
    await c.join(CALL, 'video');
    expect(c.getSnapshot().isHost).toBe(true);
    c.endForAll();
    expect(api.endCall).toHaveBeenCalledWith(CALL);
    expect(phase(c)).toBe('idle');
  });

  it('losing access (403 on the periodic re-check) ends the call', async () => {
    const { c } = setup([JOINED, Object.assign(new Error('forbidden'), { status: 403 })]);
    await c.join(CALL, 'video');
    await tick(50);
    expect(phase(c)).toBe('ended');
    expect(c.getSnapshot().reason).toMatch(/no longer have access/);
  });

  it('controls act on the room', async () => {
    const applySpeaker = jest.fn();
    const { c, rooms } = setup([JOINED], { applySpeaker });
    await c.join(CALL, 'video');
    await c.toggleMic();
    expect(rooms[0]!.mic).toBe(false);
    await c.switchCamera();
    expect(rooms[0]!.switched).toBe(1); // a video join starts with the camera on
    await c.toggleCam();
    expect(rooms[0]!.cam).toBe(false);
    await c.switchCamera();
    expect(rooms[0]!.switched).toBe(1); // camera off: nothing to flip
    await c.toggleCam();
    expect(rooms[0]!.cam).toBe(true);
    c.toggleSpeaker();
    expect(applySpeaker).toHaveBeenLastCalledWith(false);
  });

  it('turning the camera on asks for camera permission first and stays off if refused', async () => {
    const ensureCamera = jest.fn(async () => false);
    const { c, rooms } = setup([JOINED], { ensureCamera });
    await c.join(CALL, 'audio');
    await c.toggleCam();
    expect(ensureCamera).toHaveBeenCalledTimes(1);
    expect(rooms[0]!.cam).toBe(false);
    expect(c.getSnapshot().camOn).toBe(false);
  });

  it('a camera that will not start leaves the button off and tells the user', async () => {
    const cameraFailed = jest.fn();
    const { c, rooms } = setup([JOINED], { cameraFailed });
    await c.join(CALL, 'audio');
    rooms[0]!.setCam = async () => {
      throw new Error('NotReadableError');
    };
    await c.toggleCam();
    expect(c.getSnapshot().camOn).toBe(false);
    expect(cameraFailed).toHaveBeenCalledTimes(1);
  });

  it('ignores a second camera tap while the first is still starting', async () => {
    let calls = 0;
    const { c, rooms } = setup([JOINED]);
    await c.join(CALL, 'audio');
    rooms[0]!.setCam = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
    };
    await Promise.all([c.toggleCam(), c.toggleCam()]);
    expect(calls).toBe(1);
  });
});

describe('room invites', () => {
  it('rings once per call even if announced repeatedly', () => {
    const { c, events } = setup([JOINED]);
    c.announce(CALL, 'Design sync', 'video', 'Sam');
    c.announce(CALL, 'Design sync', 'video', 'Sam');
    expect(phase(c)).toBe('ringing');
    expect(events).toEqual([`ring:${CALL}`]);
  });

  it('disposing while a ring is unanswered silences it (sign-out must not leave the ringtone looping)', () => {
    const { c, events } = setup([JOINED]);
    c.announce(CALL, 'Design sync', 'video', 'Sam');
    c.dispose();
    expect(events).toContain(`done:${CALL}:ended`);
  });

  it('host Start plus the call.started event create ONE room, not two', async () => {
    const { c, rooms, emit } = setup([WAITING(true), JOINED]);
    await c.join(CALL, 'video');
    expect(phase(c)).toBe('waiting');
    const start = c.startNow();
    emit({ type: 'started', callId: CALL });
    await start;
    await tick(10);
    expect(rooms).toHaveLength(1);
    expect(phase(c)).toBe('connected');
  });

  it('accepting joins and clears the ring notification', async () => {
    const { c, events } = setup([JOINED]);
    c.announce(CALL, 'Design sync', 'video');
    await c.join(CALL, 'video');
    expect(events).toContain(`done:${CALL}:joined`);
    expect(phase(c)).toBe('connected');
  });

  it('declining dismisses without contacting the server', () => {
    const { c, api, events } = setup([JOINED]);
    c.announce(CALL, 'Design sync', 'video');
    c.decline();
    expect(phase(c)).toBe('idle');
    expect(events).toContain(`done:${CALL}:declined`);
    expect(api.leaveCall).not.toHaveBeenCalled();
    expect(api.callToken).not.toHaveBeenCalled();
  });

  it('an unanswered invite times out; the call ending dismisses it', async () => {
    const t = setup([JOINED]);
    t.c.announce(CALL, 'A', 'video');
    await tick(60);
    expect(phase(t.c)).toBe('idle');
    expect(t.events).toContain(`done:${CALL}:timeout`);
    const u = setup([JOINED]);
    u.c.announce('other', 'B', 'audio');
    u.c.dismissInvite('other');
    expect(phase(u.c)).toBe('idle');
    expect(u.events).toContain('done:other:ended');
  });

  it('a new invite is ignored while a call is on screen', async () => {
    const { c, events } = setup([JOINED]);
    await c.join(CALL, 'video');
    c.announce('another', 'X', 'video');
    expect(events).toEqual([]);
    expect(phase(c)).toBe('connected');
  });
});

describe('room state does not leak between calls', () => {
  it('leaving clears title, times and reason before the next call', async () => {
    const { c } = setup([JOINED, JOINED]);
    await c.join(CALL, 'video', 'Standup');
    expect(c.getSnapshot().connectedAt).toBeDefined();
    c.leave();
    expect(c.getSnapshot()).toMatchObject({ phase: 'idle', callId: undefined, title: undefined, connectedAt: undefined, reason: undefined, participants: [] });
    await c.join('other-call', 'audio');
    expect(c.getSnapshot().title).toBeUndefined();
    expect(c.getSnapshot().callId).toBe('other-call');
  });

  it('an invite that was declined leaves no inviter/title behind', () => {
    const { c } = setup([JOINED]);
    c.announce(CALL, 'Design sync', 'video', 'Sam');
    c.decline();
    expect(c.getSnapshot()).toMatchObject({ phase: 'idle', title: undefined, inviter: undefined, callId: undefined });
  });
});

describe('Add member to a live room call (web useCallRoom.addPeople)', () => {
  const PEOPLE = [
    { id: 'u-3', name: 'Sam' },
    { id: 'u-4', name: 'Lee' },
  ];

  it('posts one participant per person, in order, and reports them', async () => {
    const { c, api } = setup([JOINED]);
    await c.join(CALL, 'video');
    const out = await c.addPeople(PEOPLE);
    expect(api.addCallParticipant.mock.calls).toEqual([[CALL, 'u-3'], [CALL, 'u-4']]);
    expect(out).toEqual({ added: PEOPLE, failed: [], movedToRoom: false });
  });

  it('names each failure and still adds the others', async () => {
    const { c, api } = setup([JOINED]);
    await c.join(CALL, 'video');
    api.addCallParticipant.mockImplementation(async (_: string, id: string) => {
      if (id === 'u-4') throw Object.assign(new Error('forbidden'), { status: 403 });
      return {};
    });
    const progress: number[] = [];
    const out = await c.addPeople(PEOPLE, (p) => progress.push(p.done));
    expect(out.added.map((p) => p.id)).toEqual(['u-3']);
    expect(out.failed[0]).toMatchObject({ id: 'u-4', name: 'Lee' });
    expect(out.failed[0]!.message).not.toBe('');
    expect(progress).toEqual([0, 1, 2]);
  });

  it('refuses while not connected', async () => {
    const { c, api } = setup([JOINED]);
    const out = await c.addPeople(PEOPLE);
    expect(out.failed).toHaveLength(2);
    expect(api.addCallParticipant).not.toHaveBeenCalled();
  });
});

describe('room call: startMuted (joining from a link)', () => {
  /** A setup whose rooms record every setMic/setCam value ever requested. */
  function recorded(tokens: (CallJoinDTO | Error)[]) {
    const calls: string[] = [];
    const s = setup(tokens, {
      createRoom: () => {
        const r = new FakeRoom();
        const mic = r.setMic.bind(r);
        const cam = r.setCam.bind(r);
        r.setMic = async (on) => { calls.push(`mic:${on}`); return mic(on); };
        r.setCam = async (on) => { calls.push(`cam:${on}`); return cam(on); };
        s.rooms.push(r);
        return r;
      },
    });
    return { ...s, calls };
  }

  it('connects with microphone and camera OFF and never enables either', async () => {
    const { c, rooms, calls } = recorded([JOINED]);
    await c.join(CALL, 'video', 'Standup', { startMuted: true });
    expect(rooms[0]!.connected).toEqual({ url: 'wss://sfu', token: 'T' });
    expect(calls).not.toContain('mic:true');
    expect(calls).not.toContain('cam:true');
    expect(c.getSnapshot()).toMatchObject({ phase: 'connected', micOn: false, camOn: false });
  });

  it('shows mic/camera off while still joining', async () => {
    const { c } = setup([JOINED], { ensurePermissions: () => new Promise(() => { /* never resolves */ }) });
    void c.join(CALL, 'video', undefined, { startMuted: true });
    expect(c.getSnapshot()).toMatchObject({ phase: 'joining', micOn: false, camOn: false });
  });

  it('asks only for the microphone permission up front, not the camera', async () => {
    const { c, deps } = setup([JOINED]);
    await c.join(CALL, 'video', undefined, { startMuted: true });
    expect(deps.ensurePermissions).toHaveBeenCalledWith('audio');
  });

  it('the user can still turn the microphone on afterwards', async () => {
    const { c, rooms } = setup([JOINED]);
    await c.join(CALL, 'video', undefined, { startMuted: true });
    await c.toggleMic();
    expect(rooms[0]!.mic).toBe(true);
    expect(c.getSnapshot().micOn).toBe(true);
  });

  it('stays muted through the waiting room', async () => {
    const { c, rooms, emit, calls } = recorded([WAITING(false), JOINED]);
    await c.join(CALL, 'video', undefined, { startMuted: true });
    expect(c.getSnapshot()).toMatchObject({ phase: 'waiting', micOn: false, camOn: false });
    emit({ type: 'started', callId: CALL });
    await tick(5);
    expect(rooms).toHaveLength(1);
    expect(calls).not.toContain('mic:true');
    expect(calls).not.toContain('cam:true');
  });

  it('retry after a failed muted join is still muted', async () => {
    const { c, calls } = recorded([new Error('down'), JOINED]);
    await c.join(CALL, 'video', undefined, { startMuted: true });
    expect(phase(c)).toBe('failed');
    c.retry();
    await tick(5);
    expect(phase(c)).toBe('connected');
    expect(calls).not.toContain('mic:true');
    expect(calls).not.toContain('cam:true');
  });

  it('a normal join is unchanged: mic and camera go on', async () => {
    const { c, calls } = recorded([JOINED]);
    await c.join(CALL, 'video');
    expect(calls).toEqual(['mic:true', 'cam:true']);
    expect(c.getSnapshot()).toMatchObject({ micOn: true, camOn: true });
  });
});

describe('an ad-hoc call is a call, not a meeting', () => {
  it('keeps what the ring learnt through answering it', async () => {
    const { c } = setup([JOINED]);
    c.announce(CALL, 'Conference call', 'video', 'Jordan', 'u-1', true);
    expect(c.getSnapshot()).toMatchObject({ phase: 'ringing', adhoc: true, title: 'Conference call' });

    await c.join(CALL, 'video', c.getSnapshot().title);

    expect(c.getSnapshot()).toMatchObject({ phase: 'connected', adhoc: true, title: 'Conference call' });
  });

  it('is told by whoever enters it directly — the caller who widened a 1:1, or started a conference', async () => {
    const { c } = setup([JOINED]);
    await c.join(CALL, 'video', 'Conference call', { adhoc: true });
    expect(c.getSnapshot().adhoc).toBe(true);
  });

  it('a meeting is not ad-hoc, and one call does not leak into the next', async () => {
    const { c } = setup([JOINED]);
    await c.join(CALL, 'video', 'Conference call', { adhoc: true });
    c.leave();
    await tick(40);
    await c.join('55555555-5555-4555-8555-555555555555', 'video', 'Standup');
    expect(c.getSnapshot().adhoc).toBeUndefined();
  });

  it('survives a retry after a failed join', async () => {
    const { c } = setup([new Error('down'), JOINED]);
    await c.join(CALL, 'video', 'Conference call', { adhoc: true });
    expect(phase(c)).toBe('failed');
    c.retry();
    await tick(10);
    expect(c.getSnapshot()).toMatchObject({ phase: 'connected', adhoc: true });
  });

  it('leaving does not end it for the others — only the host pressing End does', async () => {
    const { c, api } = setup([JOINED]);
    await c.join(CALL, 'video', 'Conference call', { adhoc: true });
    c.leave();
    expect(api.leaveCall).toHaveBeenCalledWith(CALL);
    expect(api.endCall).not.toHaveBeenCalled();
  });
});
