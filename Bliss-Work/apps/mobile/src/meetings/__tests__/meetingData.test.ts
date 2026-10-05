import { MeetingData, type MeetingDataApi, type MeetingDataDeps } from '../meetingData';
import { decodeRoomMessage, encodeRoomMessage, type RoomMessage } from '../roomData';

const ME = 'me-id';
const tick = () => new Promise((r) => setImmediate(r));

function setup(over: Partial<MeetingDataDeps> = {}, apiOver: Partial<MeetingDataApi> = {}) {
  const sent: { msg: RoomMessage; to?: string[] }[] = [];
  let cb: ((m: RoomMessage, from: string) => void) | undefined;
  const api: MeetingDataApi = {
    saveCallChat: jest.fn(async () => ({})),
    saveCallNote: jest.fn(async () => ({})),
    callChat: jest.fn(async () => ({ items: [], nextCursor: null })),
    callNotes: jest.fn(async () => ({ items: [], nextCursor: null })),
    ...apiOver,
  };
  let t = 1000;
  const d = new MeetingData({
    callId: 'call-1',
    selfIdentity: () => ME,
    selfName: () => 'Me',
    send: (msg, to) => sent.push({ msg, to }),
    onData: (f) => {
      cb = f;
      return () => { cb = undefined; };
    },
    api,
    nameOf: (id) => ({ u2: 'Priya' } as Record<string, string>)[id],
    now: () => t++,
    ...over,
  });
  d.start();
  return { d, sent, api, recv: (m: RoomMessage, from: string) => cb?.(m, from) };
}

describe('joining', () => {
  it('asks the room what it missed and reads the stored record', async () => {
    const { d, sent, api } = setup();
    expect(sent.map((s) => s.msg.t)).toEqual(['notes-request', 'chat-request']);
    await tick();
    expect(api.callChat).toHaveBeenCalledWith('call-1', undefined);
    expect(api.callNotes).toHaveBeenCalledWith('call-1', undefined);
    expect(d.getSnapshot().loadingHistory).toBe(false);
  });

  it('merges stored history with names, paging until the end, without duplicating live copies', async () => {
    const callChat = jest
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'c1', senderId: 'u2', text: 'old 1', sentAt: '2026-09-28T10:00:00Z' }], nextCursor: 'p2' })
      .mockResolvedValueOnce({ items: [{ id: 'c2', senderId: 'u3', text: 'old 2', sentAt: '2026-09-28T10:01:00Z' }], nextCursor: null });
    const { d, recv } = setup({}, { callChat });
    recv({ t: 'chat', msg: { id: 'c1', from: 'u2', fromName: 'Priya', to: null, text: 'old 1', at: Date.parse('2026-09-28T10:00:00Z') } }, 'u2');
    await tick();
    const chat = d.getSnapshot().chat;
    expect(chat.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(chat[0]!.fromName).toBe('Priya');
    expect(chat[1]!.fromName).toBe('u3'.slice(0, 8));
    expect(callChat).toHaveBeenCalledTimes(2);
  });

  it('a failing transcript read never breaks the meeting', async () => {
    const { d } = setup({}, { callChat: jest.fn(async () => { throw new Error('404'); }) });
    await tick();
    expect(d.getSnapshot().loadingHistory).toBe(false);
  });
});

describe('chat', () => {
  it('a sent message goes to everyone, appears locally, and is kept on the server once', async () => {
    const { d, sent, api } = setup();
    const e = d.sendChat('  hello team  ')!;
    expect(e.text).toBe('hello team');
    const out = sent.find((s) => s.msg.t === 'chat')!;
    expect(out.to).toBeUndefined();
    expect(d.getSnapshot().chat).toHaveLength(1);
    expect(api.saveCallChat).toHaveBeenCalledWith('call-1', { id: e.id, text: 'hello team', at: e.at });
    expect(d.getSnapshot().unread).toBe(0);
  });

  it('a private message is addressed on the wire and is NOT written to the record', () => {
    const { d, sent, api } = setup();
    d.sendChat('psst', 'u2');
    expect(sent.find((s) => s.msg.t === 'chat')!.to).toEqual(['u2']);
    expect(api.saveCallChat).not.toHaveBeenCalled();
  });

  it('empty text is not sent', () => {
    const { d, sent } = setup();
    expect(d.sendChat('   ')).toBeNull();
    expect(sent.filter((s) => s.msg.t === 'chat')).toHaveLength(0);
  });

  it('a failed record write is visible but does not lose the message', async () => {
    const { d } = setup({}, { saveCallChat: jest.fn(async () => { throw new Error('offline'); }) });
    d.sendChat('still delivered');
    await tick();
    expect(d.getSnapshot().chat).toHaveLength(1);
    expect(d.getSnapshot().keepFailed).toBe(true);
  });

  it('counts unread until the panel is looked at, and never counts your own', () => {
    const { d, recv } = setup();
    const m = (id: string, at: number) => ({ t: 'chat', msg: { id, from: 'u2', fromName: 'Priya', to: null, text: id, at } }) as RoomMessage;
    recv(m('a', 5000), 'u2');
    recv(m('b', 5001), 'u2');
    expect(d.getSnapshot().unread).toBe(2);
    d.sendChat('mine');
    expect(d.getSnapshot().unread).toBe(2);
    d.setChatVisible(true);
    expect(d.getSnapshot().unread).toBe(0);
    recv(m('c', 9000), 'u2');
    expect(d.getSnapshot().unread).toBe(0);
    d.setChatVisible(false);
    recv(m('d', 9500), 'u2');
    expect(d.getSnapshot().unread).toBe(1);
  });

  it("ignores a private message that isn't ours, even if it arrives", () => {
    const { d, recv } = setup();
    recv({ t: 'chat', msg: { id: 'x', from: 'u2', fromName: 'P', to: 'someone-else', text: 'secret', at: 5000 } }, 'u2');
    expect(d.getSnapshot().chat).toHaveLength(0);
  });

  it('answers a newcomer with room chat only, addressed to that newcomer', () => {
    const { d, sent, recv } = setup();
    d.sendChat('to all');
    d.sendChat('dm to bob', 'bob');
    sent.length = 0;
    recv({ t: 'chat-request' }, 'carol');
    const reply = sent.find((s) => s.msg.t === 'chat-sync')!;
    expect(reply.to).toEqual(['carol']);
    expect(reply.msg.t === 'chat-sync' && reply.msg.msgs.map((c) => c.text)).toEqual(['to all']);
    sent.length = 0;
    recv({ t: 'chat-request' }, 'bob');
    expect((sent[0]!.msg as { msgs: { text: string }[] }).msgs.map((c) => c.text)).toEqual(['to all', 'dm to bob']);
  });
});

describe('notes', () => {
  it('a note is shared with the room and kept against this meeting', () => {
    const { d, sent, api } = setup();
    const n = d.addNote('Ship on Friday')!;
    expect(sent.find((s) => s.msg.t === 'note')).toBeDefined();
    expect(api.saveCallNote).toHaveBeenCalledWith('call-1', { id: n.id, text: 'Ship on Friday', at: n.at });
    expect(d.getSnapshot().notes.map((x) => x.text)).toEqual(['Ship on Friday']);
  });

  it("merges other people's notes and syncs to newcomers", () => {
    const { d, sent, recv } = setup();
    recv({ t: 'note', note: { id: 'n1', author: 'Priya', text: 'from web', at: 5000 } }, 'u2');
    recv({ t: 'notes-sync', notes: [{ id: 'n1', author: 'Priya', text: 'from web', at: 5000 }, { id: 'n2', author: 'Sam', text: 'second', at: 5001 }] }, 'u3');
    expect(d.getSnapshot().notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    sent.length = 0;
    recv({ t: 'notes-request' }, 'newbie');
    expect(sent[0]).toMatchObject({ to: ['newbie'] });
  });
});

describe('wire compatibility', () => {
  it('what it publishes decodes as a web-format message', () => {
    const { d, sent } = setup();
    d.sendChat('hi web');
    const bytes = encodeRoomMessage(sent.find((s) => s.msg.t === 'chat')!.msg);
    expect(decodeRoomMessage(bytes)).toMatchObject({ t: 'chat', msg: { text: 'hi web', from: ME, fromName: 'Me', to: null } });
  });
});

describe('dispose', () => {
  it('stops listening', () => {
    const { d, recv } = setup();
    d.dispose();
    recv({ t: 'note', note: { id: 'n', author: 'A', text: 'x', at: 1 } }, 'u');
    expect(d.getSnapshot().notes).toHaveLength(0);
  });
});
