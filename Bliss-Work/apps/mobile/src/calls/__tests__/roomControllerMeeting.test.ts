import type { CallJoinDTO } from '@taskboard/shared';
import { RoomController, type RoomDeps, type RoomLike, type RoomParticipantView } from '../roomController';

const CALL = '44444444-4444-4444-8444-444444444444';
const JOINED: CallJoinDTO = { state: 'JOINED', url: 'wss://sfu', token: 'T', room: 'r', identity: 'me', expiresAt: 'x', role: 'PARTICIPANT' };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class Room implements RoomLike {
  people: RoomParticipantView[] = [{ identity: 'me', name: 'Me', isLocal: true, speaking: false, micOn: true, camOn: false }];
  published: { bytes: Uint8Array; to?: string[] }[] = [];
  dataCbs = new Set<(b: Uint8Array, from: string) => void>();
  shareEnded = new Set<() => void>();
  shareCalls: boolean[] = [];
  refuseShare = false;
  async connect() {}
  async disconnect() {}
  async setMic() {}
  async setCam() {}
  switchCamera() {}
  participants() { return this.people; }
  onChange() { return () => {}; }
  onReconnecting() { return () => {}; }
  onReconnected() { return () => {}; }
  onDisconnected() { return () => {}; }
  async sendData(bytes: Uint8Array, to?: string[]) { this.published.push({ bytes, to }); }
  onData(cb: (b: Uint8Array, from: string) => void) { this.dataCbs.add(cb); return () => this.dataCbs.delete(cb); }
  async setScreenShare(on: boolean) {
    if (on && this.refuseShare) throw new Error('permission denied');
    this.shareCalls.push(on);
    // like LiveKit: unpublishing our own share also emits the "ended" event
    if (!on) this.shareEnded.forEach((f) => f());
    if (on) this.people = this.people.map((p) => (p.isLocal ? { ...p, sharing: true } : p));
  }
  onScreenShareEnded(cb: () => void) { this.shareEnded.add(cb); return () => this.shareEnded.delete(cb); }
}

const live: RoomController[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.dispose();
});

function setup(plainRoom = false) {
  const rooms: RoomLike[] = [];
  const api = {
    callToken: jest.fn(async () => JOINED),
    startCall: jest.fn(async () => ({}) as never),
    leaveCall: jest.fn(async () => undefined),
    endCall: jest.fn(async () => undefined),
    addCallParticipant: jest.fn(async () => undefined),
    startScreenShare: jest.fn(async () => undefined),
    stopScreenShare: jest.fn(async () => undefined),
  };
  const shareChanges: boolean[] = [];
  const deps: RoomDeps = {
    api,
    createRoom: () => {
      const r: RoomLike = plainRoom
        ? { connect: async () => {}, disconnect: async () => {}, setMic: async () => {}, setCam: async () => {}, switchCamera() {}, participants: () => [], onChange: () => () => {}, onReconnecting: () => () => {}, onReconnected: () => () => {}, onDisconnected: () => () => {} }
        : new Room();
      rooms.push(r);
      return r;
    },
    onCallEvent: () => () => {},
    ensurePermissions: async () => true,
    accessCheckMs: 100000,
    onScreenShareChanged: (sharing) => shareChanges.push(sharing),
  };
  const c = new RoomController(deps);
  live.push(c);
  return { c, api, rooms, shareChanges };
}

describe('data channel for meeting chat/notes', () => {
  it('publishes bytes (optionally addressed) through the current room', async () => {
    const { c, rooms } = setup();
    await c.join(CALL, 'video', 'Sync');
    c.sendData(new Uint8Array([1, 2]), ['bob']);
    c.sendData(new Uint8Array([3]));
    const r = rooms[0] as Room;
    expect(r.published).toEqual([{ bytes: new Uint8Array([1, 2]), to: ['bob'] }, { bytes: new Uint8Array([3]), to: undefined }]);
  });

  it('delivers incoming bytes to subscribers, and unsubscribing stops it', async () => {
    const { c, rooms } = setup();
    const got: string[] = [];
    const off = c.onData((b, from) => got.push(`${from}:${b[0]}`));
    await c.join(CALL, 'video');
    (rooms[0] as Room).dataCbs.forEach((f) => f(new Uint8Array([7]), 'alice'));
    off();
    (rooms[0] as Room).dataCbs.forEach((f) => f(new Uint8Array([8]), 'alice'));
    expect(got).toEqual(['alice:7']);
  });

  it('is a safe no-op before there is a room, or on a room without a data channel', async () => {
    const a = setup();
    a.c.sendData(new Uint8Array([1]));
    const b = setup(true);
    await b.c.join(CALL, 'video');
    expect(() => b.c.sendData(new Uint8Array([1]))).not.toThrow();
    expect(b.c.getSnapshot().canShareScreen).toBe(false);
  });
});

describe('raise hand', () => {
  const enc = (m: object) => new TextEncoder().encode(JSON.stringify(m));
  const alice: RoomParticipantView = { identity: 'alice', name: 'Alice', isLocal: false, speaking: false, micOn: true, camOn: false };
  const handOf = (c: RoomController, id: string) => c.getSnapshot().participants.find((p) => p.identity === id)?.handRaised;

  it('a raised hand survives a screen-share toggle (which re-snapshots the participants)', async () => {
    const { c, rooms } = setup();
    await c.join(CALL, 'video');
    const r = rooms[0] as Room;
    r.people = [...r.people, alice];
    r.dataCbs.forEach((f) => f(enc({ t: 'hand', raised: true }), 'alice'));
    expect(handOf(c, 'alice')).toBe(true);
    await c.toggleScreenShare();
    expect(handOf(c, 'alice')).toBe(true);
  });

  it('a hand does not come back when the person leaves and rejoins', async () => {
    const { c, rooms } = setup();
    await c.join(CALL, 'video');
    const r = rooms[0] as Room;
    r.people = [...r.people, alice];
    r.dataCbs.forEach((f) => f(enc({ t: 'hand', raised: true }), 'alice'));
    r.people = r.people.filter((p) => p.identity !== 'alice');
    await c.toggleScreenShare(); // any re-snapshot while she is gone
    r.people = [...r.people, alice];
    await c.toggleScreenShare();
    expect(handOf(c, 'alice')).toBe(false);
  });
});

describe('screen sharing', () => {
  it('starts: publishes the screen, marks us as sharing, and records it on the meeting', async () => {
    const { c, api, rooms } = setup();
    await c.join(CALL, 'video');
    expect(c.getSnapshot().canShareScreen).toBe(true);
    expect(await c.toggleScreenShare()).toBe(true);
    expect((rooms[0] as Room).shareCalls).toEqual([true]);
    expect(c.getSnapshot().sharing).toBe(true);
    expect(c.getSnapshot().participants[0]!.sharing).toBe(true);
    expect(api.startScreenShare).toHaveBeenCalledWith(CALL, 'monitor');
  });

  it('stops: unpublishes, clears the state, and tells the meeting exactly once', async () => {
    const { c, api, rooms } = setup();
    await c.join(CALL, 'video');
    await c.toggleScreenShare();
    expect(await c.toggleScreenShare()).toBe(false);
    expect((rooms[0] as Room).shareCalls).toEqual([true, false]);
    expect(c.getSnapshot().sharing).toBe(false);
    await tick();
    expect(api.stopScreenShare).toHaveBeenCalledTimes(1);
  });

  it('a refused OS consent leaves everything as it was', async () => {
    const { c, api, rooms } = setup();
    await c.join(CALL, 'video');
    (rooms[0] as Room).refuseShare = true;
    expect(await c.toggleScreenShare()).toBe(false);
    expect(c.getSnapshot().sharing).toBe(false);
    expect(api.startScreenShare).not.toHaveBeenCalled();
  });

  it('the system stopping the share (not us) is reflected and reported', async () => {
    const { c, api, rooms } = setup();
    await c.join(CALL, 'video');
    await c.toggleScreenShare();
    (rooms[0] as Room).shareEnded.forEach((f) => f());
    expect(c.getSnapshot().sharing).toBe(false);
    await tick();
    expect(api.stopScreenShare).toHaveBeenCalledTimes(1);
  });

  it('is not offered on a room that cannot share, and does nothing when not connected', async () => {
    const a = setup(true);
    await a.c.join(CALL, 'video');
    expect(await a.c.toggleScreenShare()).toBe(false);
    const b = setup();
    expect(await b.c.toggleScreenShare()).toBe(false);
  });

  it('leaving clears the sharing state for the next meeting', async () => {
    const { c } = setup();
    await c.join(CALL, 'video');
    await c.toggleScreenShare();
    c.leave();
    expect(c.getSnapshot()).toMatchObject({ sharing: false, canShareScreen: false, participants: [] });
  });

  // Screenshot/screen-record protection (FLAG_SECURE) is lifted for exactly the
  // live duration of a share and must always come back — see screenSecurity.ts.
  // toggleScreenShare's two `set()` calls are covered directly by the assertions
  // above (sharing: true/false); these cover the `replace()` reset paths, which
  // a naive fix would miss since they bypass set() entirely.
  describe('onScreenShareChanged (screenshot-protection hook)', () => {
    it('fires true on start and false on an explicit stop, and not before/after', async () => {
      const { c, shareChanges } = setup();
      await c.join(CALL, 'video');
      expect(shareChanges).toEqual([]);
      await c.toggleScreenShare();
      expect(shareChanges).toEqual([true]);
      await c.toggleScreenShare();
      expect(shareChanges).toEqual([true, false]);
    });

    it('fires false when the OS/system ends the share, not just an explicit toggle-off', async () => {
      const { c, rooms, shareChanges } = setup();
      await c.join(CALL, 'video');
      await c.toggleScreenShare();
      (rooms[0] as Room).shareEnded.forEach((f) => f());
      expect(shareChanges).toEqual([true, false]);
    });

    it('never fires for a refused OS consent (sharing never actually started)', async () => {
      const { c, rooms, shareChanges } = setup();
      await c.join(CALL, 'video');
      (rooms[0] as Room).refuseShare = true;
      await c.toggleScreenShare();
      expect(shareChanges).toEqual([]);
    });

    it('fires false when the call resets straight to idle mid-share (leave) — the replace() path', async () => {
      const { c, shareChanges } = setup();
      await c.join(CALL, 'video');
      await c.toggleScreenShare();
      expect(shareChanges).toEqual([true]);
      c.leave();
      expect(shareChanges).toEqual([true, false]);
    });
  });
});
