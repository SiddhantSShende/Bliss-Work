import { MeetingHub, EMPTY_MEETING_DATA, type HubRoom } from '../meetingHub';
import { decodeRoomMessage, encodeRoomMessage } from '../roomData';
import type { MeetingDataApi } from '../meetingData';

const tick = () => new Promise((r) => setImmediate(r));

function fakeRoom() {
  let snap = { phase: 'idle', callId: undefined as string | undefined };
  const subs = new Set<() => void>();
  const published: { bytes: Uint8Array; to?: string[] }[] = [];
  const dataCbs = new Set<(b: Uint8Array, from: string) => void>();
  const room: HubRoom = {
    getSnapshot: () => snap,
    subscribe: (l) => { subs.add(l); return () => subs.delete(l); },
    sendData: (bytes, to) => { published.push({ bytes, to }); },
    onData: (cb) => { dataCbs.add(cb); return () => dataCbs.delete(cb); },
  };
  return {
    room,
    published,
    dataCbs,
    set: (phase: string, callId?: string) => { snap = { phase, callId }; subs.forEach((f) => f()); },
  };
}

const api = (): MeetingDataApi => ({
  saveCallChat: jest.fn(async () => ({})),
  saveCallNote: jest.fn(async () => ({})),
  callChat: jest.fn(async () => ({ items: [], nextCursor: null })),
  callNotes: jest.fn(async () => ({ items: [], nextCursor: null })),
});

describe('MeetingHub', () => {
  it('starts chat/notes when the room connects and stops when it ends', async () => {
    const r = fakeRoom();
    const a = api();
    const hub = new MeetingHub({ room: r.room, api: a, selfIdentity: () => 'me', selfName: () => 'Me' });
    expect(hub.getSnapshot()).toBe(EMPTY_MEETING_DATA);
    expect(hub.sendChat('nobody home')).toBeNull();

    r.set('connected', 'call-1');
    await tick();
    expect(a.callChat).toHaveBeenCalledWith('call-1', undefined);
    expect(r.published.map((p) => decodeRoomMessage(p.bytes)?.t)).toEqual(['notes-request', 'chat-request']);

    hub.sendChat('hello');
    expect(hub.getSnapshot().chat).toHaveLength(1);
    expect(a.saveCallChat).toHaveBeenCalledTimes(1);

    r.set('idle');
    expect(hub.getSnapshot()).toBe(EMPTY_MEETING_DATA);
    expect(hub.sendChat('after')).toBeNull();
    hub.dispose();
  });

  it('routes room data into the meeting, and a bad payload is ignored', async () => {
    const r = fakeRoom();
    const hub = new MeetingHub({ room: r.room, api: api(), selfIdentity: () => 'me', selfName: () => 'Me' });
    r.set('connected', 'call-1');
    const chat = { t: 'chat' as const, msg: { id: 'u-1', from: 'u', fromName: 'U', to: null, text: 'hey', at: 5 } };
    r.dataCbs.forEach((f) => f(encodeRoomMessage(chat), 'u'));
    r.dataCbs.forEach((f) => f(new TextEncoder().encode('garbage'), 'u'));
    expect(hub.getSnapshot().chat.map((c) => c.text)).toEqual(['hey']);
    hub.dispose();
  });

  it('a reconnect keeps the same meeting; a different call starts a fresh one', async () => {
    const r = fakeRoom();
    const hub = new MeetingHub({ room: r.room, api: api(), selfIdentity: () => 'me', selfName: () => 'Me' });
    r.set('connected', 'call-1');
    hub.sendChat('one');
    r.set('reconnecting', 'call-1');
    r.set('connected', 'call-1');
    expect(hub.getSnapshot().chat).toHaveLength(1);
    r.set('connected', 'call-2');
    expect(hub.getSnapshot().chat).toHaveLength(0);
    hub.dispose();
  });

  it('does not notify subscribers for updates that change nothing', async () => {
    const r = fakeRoom();
    const hub = new MeetingHub({ room: r.room, api: api(), selfIdentity: () => 'me', selfName: () => 'Me' });
    let n = 0;
    hub.subscribe(() => n++);
    r.set('joining', 'call-1');
    r.set('waiting', 'call-1');
    expect(n).toBe(0);
    hub.dispose();
  });
});
