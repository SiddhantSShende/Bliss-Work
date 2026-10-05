import { useMemo, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Pinned chats/channels, kept on THIS DEVICE. messaging-svc has no per-reader
 * pin flag (no column on ConversationDTO/ChannelDTO, no endpoint — checked
 * packages/shared/src/types/domain.ts and the full API client before writing
 * this), so this mirrors mailPrefs.ts's own precedent for the exact same
 * situation (mobile's twin of packages/app/src/lib/mailPrefs.ts, which keeps
 * starred mail in localStorage for the same reason): AsyncStorage is the
 * right store since this isn't a secret, and there is nothing durable to
 * fetch it from on another device — a pin set here does not sync elsewhere.
 *
 * No org scoping in the storage key: conversation/channel ids are globally
 * unique (UUIDs), and each org's Chats/Channels list only ever contains ITS
 * OWN ids, so the natural intersection of "pinned ids" with "ids visible in
 * the org currently loaded" already keeps Org A's pins from ever rendering
 * under Org B — the exact behavior requested — without an explicit key. A
 * pin from Org A that Org B could never see just sits inert in storage until
 * you're back in Org A, same as mailPrefs.ts already does across mailboxes.
 *
 * Order: most-recently-pinned first. There is no backend pinnedAt to sort
 * by, so this never invents one — prepending on pin is simply what makes the
 * array's own order the deterministic, non-random ordering the newest pin
 * naturally reads top-to-bottom.
 */
const STORAGE_KEY = 'tb.pinned.threads';

type State = Readonly<{ chats: readonly string[]; channels: readonly string[] }>;

let state: State = { chats: [], channels: [] };
let loadStarted = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function readIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : [];
}

async function load() {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { chats?: unknown; channels?: unknown };
    const chats = readIds(parsed.chats);
    const channels = readIds(parsed.channels);
    // Merge, so a pin tapped before the disk read finished is not lost.
    state = {
      chats: Array.from(new Set([...state.chats, ...chats])),
      channels: Array.from(new Set([...state.channels, ...channels])),
    };
    emit();
  } catch {
    // Unreadable/corrupt prefs just mean "no pins yet".
  }
}

function subscribe(cb: () => void) {
  void load();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function persist() {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => undefined);
}

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [id, ...list];
}

/** Plain, non-React API — directly testable the same way quickActionStore.ts
 *  is (no hook-rendering library in this project's Jest setup), and what
 *  `usePinnedThreads` below wraps for components. */
export const pinnedThreads = {
  get: (): State => state,
  toggleChat(conversationId: string): void {
    state = { ...state, chats: toggle(state.chats, conversationId) };
    emit();
    persist();
  },
  toggleChannel(channelId: string): void {
    state = { ...state, channels: toggle(state.channels, channelId) };
    emit();
    persist();
  },
  subscribe,
};

export const toggleChatPin = pinnedThreads.toggleChat;
export const toggleChannelPin = pinnedThreads.toggleChannel;

export function usePinnedThreads() {
  const snap = useSyncExternalStore(subscribe, () => state, () => state);
  return useMemo(
    () => ({
      isChatPinned: (id: string) => snap.chats.includes(id),
      isChannelPinned: (id: string) => snap.channels.includes(id),
      /** Ids in pin order (newest first) — callers intersect this with what
       *  they actually have loaded, which is what keeps this org-safe. */
      pinnedChatIds: snap.chats,
      pinnedChannelIds: snap.channels,
    }),
    [snap],
  );
}
