import {
  CHAT_TEXT_MAX,
  decodeRoomMessage,
  encodeRoomMessage,
  isChatEntry,
  mergeChat,
  mergeNotes,
  newChatEntry,
  newNoteEntry,
  truncateToUtf8Bytes,
  unreadSince,
  utf8ByteLength,
  visibleToMe,
  visibleToPeer,
  type ChatEntry,
  type RoomMessage,
} from '../roomData';

const chat = (o: Partial<ChatEntry> = {}): ChatEntry => ({ id: 'a-1-x', from: 'a', fromName: 'Ann', to: null, text: 'hi', at: 1000, ...o });
const rt = (m: RoomMessage) => decodeRoomMessage(encodeRoomMessage(m));

describe('wire format (compatible with web roomMessages)', () => {
  it('round-trips every message kind', () => {
    const n = newNoteEntry({ identity: 'a', author: 'Ann', text: 'point', at: 5 });
    const msgs: RoomMessage[] = [
      { t: 'hand', raised: true },
      { t: 'note', note: n },
      { t: 'notes-request' },
      { t: 'notes-sync', notes: [n] },
      { t: 'chat', msg: chat() },
      { t: 'chat-request' },
      { t: 'chat-sync', msgs: [chat()] },
      { t: 'recording', on: false },
    ];
    for (const m of msgs) expect(rt(m)).toEqual(m);
  });

  it('decodes a message exactly as the web client writes it', () => {
    const webBytes = new TextEncoder().encode(JSON.stringify({ t: 'chat', msg: { id: 'u-1-abc', from: 'u', fromName: 'Web User', to: null, text: 'from browser', at: 1700000000000 } }));
    expect(decodeRoomMessage(webBytes)).toMatchObject({ t: 'chat', msg: { text: 'from browser', fromName: 'Web User' } });
  });

  it('drops malformed, oversized and unknown messages instead of trusting them', () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(decodeRoomMessage(new TextEncoder().encode('not json'))).toBeNull();
    expect(decodeRoomMessage(enc(null))).toBeNull();
    expect(decodeRoomMessage(enc({ t: 'nope' }))).toBeNull();
    expect(decodeRoomMessage(enc({ t: 'hand', raised: 'yes' }))).toBeNull();
    expect(decodeRoomMessage(enc({ t: 'chat', msg: chat({ text: '' }) }))).toBeNull();
    expect(decodeRoomMessage(enc({ t: 'chat', msg: chat({ text: 'x'.repeat(CHAT_TEXT_MAX + 1) }) }))).toBeNull();
    expect(decodeRoomMessage(enc({ t: 'chat', msg: chat({ id: 'x'.repeat(65) }) }))).toBeNull();
    expect(decodeRoomMessage(enc({ t: 'chat', msg: { ...chat(), at: 'now' } }))).toBeNull();
  });

  it('a sync keeps the valid entries when one is bad', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ t: 'chat-sync', msgs: [chat(), { junk: true }, chat({ id: 'b-2-y' })] }));
    const m = decodeRoomMessage(bytes);
    expect(m?.t === 'chat-sync' && m.msgs.map((c) => c.id)).toEqual(['a-1-x', 'b-2-y']);
  });
});

describe('byte limits (server counts UTF-8 bytes, not characters)', () => {
  it('measures and truncates in bytes without splitting a codepoint', () => {
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('日')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    const t = truncateToUtf8Bytes('日'.repeat(200), 500);
    expect(utf8ByteLength(t)).toBeLessThanOrEqual(500);
    expect(t.length).toBe(166);
    expect(truncateToUtf8Bytes('😀😀😀', 6)).toBe('😀');
    expect(truncateToUtf8Bytes('hello', 500)).toBe('hello');
  });

  it('a CJK message that reads as short is still capped at 500 bytes', () => {
    const e = newChatEntry({ from: 'a', fromName: 'A', to: null, text: '日'.repeat(300) });
    expect(utf8ByteLength(e.text)).toBeLessThanOrEqual(CHAT_TEXT_MAX);
    expect(isChatEntry(e)).toBe(true);
  });
});

describe('merge', () => {
  it('dedupes by id, sorts by time, and returns the same array when nothing is new', () => {
    const a = chat({ id: 'a', at: 20 });
    const b = chat({ id: 'b', at: 10 });
    const merged = mergeChat([a], [b, a]);
    expect(merged.map((c) => c.id)).toEqual(['b', 'a']);
    expect(mergeChat(merged, [a, b])).toBe(merged);
  });

  it('keeps the newest when the cap bites and ignores invalid entries', () => {
    const many = Array.from({ length: 510 }, (_, i) => chat({ id: `m${i}`, at: i }));
    const merged = mergeChat([], many);
    expect(merged).toHaveLength(500);
    expect(merged[0]!.id).toBe('m10');
    expect(mergeChat([], [{ nope: 1 } as never])).toEqual([]);
    expect(mergeNotes([], [{ id: 'n', author: 'A', text: 'ok', at: 1 }, { id: '', author: 'A', text: 'bad', at: 1 }])).toHaveLength(1);
  });
});

describe('privacy and unread', () => {
  it('private messages are visible only to the two parties', () => {
    const dm = chat({ from: 'a', to: 'b' });
    expect(visibleToMe(dm, 'a')).toBe(true);
    expect(visibleToMe(dm, 'b')).toBe(true);
    expect(visibleToMe(dm, 'c')).toBe(false);
    expect(visibleToPeer(dm, 'c')).toBe(false);
    expect(visibleToPeer(chat(), 'c')).toBe(true);
  });

  it("counts other people's messages after the mark, never your own", () => {
    const list = [chat({ id: '1', from: 'me', at: 5 }), chat({ id: '2', from: 'x', at: 6 }), chat({ id: '3', from: 'x', at: 2 })];
    expect(unreadSince(list, 3, 'me')).toBe(1);
    expect(unreadSince(list, 0, 'me')).toBe(2);
  });
});
