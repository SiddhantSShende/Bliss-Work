import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** Recently used emoji, newest first, persisted on the device (not sensitive: AsyncStorage). */
const KEY = 'tb.emoji.recent';
const MAX = 24;

let recent: readonly string[] = [];
let loadStarted = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

async function load() {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) {
      const stored = parsed.filter((e): e is string => typeof e === 'string');
      // Keep anything picked before the disk read finished.
      recent = Array.from(new Set([...recent, ...stored])).slice(0, MAX);
      emit();
    }
  } catch {
    // Unreadable prefs just mean "no recents yet".
  }
}

function subscribe(cb: () => void) {
  void load();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function rememberEmoji(emoji: string): void {
  recent = [emoji, ...recent.filter((e) => e !== emoji)].slice(0, MAX);
  emit();
  AsyncStorage.setItem(KEY, JSON.stringify(recent)).catch(() => undefined);
}

export function useRecentEmoji(): readonly string[] {
  return useSyncExternalStore(subscribe, () => recent, () => recent);
}
