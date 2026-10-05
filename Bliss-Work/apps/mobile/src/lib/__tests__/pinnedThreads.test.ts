// A trivial in-memory stand-in — the package's own jest mock ships as
// untransformed ESM, which this project's Jest config (deliberately) does
// not transform out of node_modules. Module-level so it survives
// jest.resetModules() within a test (that only clears the require cache,
// letting a "restart" re-import pinnedThreads.ts fresh while still reading
// back what an earlier require() in the SAME test wrote here).
const mockDisk: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => mockDisk[k] ?? null,
    setItem: async (k: string, v: string) => {
      mockDisk[k] = v;
    },
  },
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('pinnedThreads', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('pins and unpins a chat, independently of channels', () => {
    const { pinnedThreads } = require('../pinnedThreads');
    const off = pinnedThreads.subscribe(() => undefined);

    pinnedThreads.toggleChat('chat-a');
    expect(pinnedThreads.get().chats).toEqual(['chat-a']);
    expect(pinnedThreads.get().channels).toEqual([]); // never crosses into the channel set

    pinnedThreads.toggleChannel('chan-a');
    expect(pinnedThreads.get().channels).toEqual(['chan-a']);
    expect(pinnedThreads.get().chats).toEqual(['chat-a']); // and not the other way around

    pinnedThreads.toggleChat('chat-a');
    expect(pinnedThreads.get().chats).toEqual([]);
    expect(pinnedThreads.get().channels).toEqual(['chan-a']); // unpinning a chat leaves channel pins alone
    off();
  });

  it('newest pin reads first — deterministic order, no invented timestamps', () => {
    const { pinnedThreads } = require('../pinnedThreads');

    pinnedThreads.toggleChat('a');
    pinnedThreads.toggleChat('b');
    pinnedThreads.toggleChat('c');
    expect(pinnedThreads.get().chats).toEqual(['c', 'b', 'a']);

    pinnedThreads.toggleChat('b'); // unpin the middle one
    expect(pinnedThreads.get().chats).toEqual(['c', 'a']);

    pinnedThreads.toggleChat('b'); // re-pin — jumps back to newest, not its old slot
    expect(pinnedThreads.get().chats).toEqual(['b', 'c', 'a']);
  });

  it('notifies subscribers on every toggle', () => {
    const { pinnedThreads } = require('../pinnedThreads');
    const seen: string[][] = [];
    const off = pinnedThreads.subscribe(() => seen.push([...pinnedThreads.get().chats]));

    pinnedThreads.toggleChat('x');
    pinnedThreads.toggleChat('y');
    pinnedThreads.toggleChat('x');
    expect(seen).toEqual([['x'], ['y', 'x'], ['y']]);
    off();
  });

  it('persists across a simulated app restart (fresh module + AsyncStorage read)', async () => {
    const first = require('../pinnedThreads');
    first.pinnedThreads.toggleChat('durable-chat');
    first.pinnedThreads.toggleChannel('durable-channel');
    await flush(); // AsyncStorage.setItem is fire-and-forget in the module

    jest.resetModules();
    const second = require('../pinnedThreads');
    const off = second.pinnedThreads.subscribe(() => undefined); // subscribing triggers the load
    await flush();
    expect(second.pinnedThreads.get().chats).toEqual(['durable-chat']);
    expect(second.pinnedThreads.get().channels).toEqual(['durable-channel']);
    off();
  });
});
