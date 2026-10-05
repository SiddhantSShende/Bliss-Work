import { useMemo, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Favourite (starred) mail, kept on THIS DEVICE — the mobile twin of
 * packages/app/src/lib/mailPrefs.ts. messaging-svc has no per-reader star flag
 * (no column, no endpoint), which is why web keeps the mark in localStorage too;
 * here it lives in AsyncStorage. Not a secret, so AsyncStorage (not Keychain) is right.
 */
const STORAGE_KEY = 'tb.mail.prefs';

type State = Readonly<{ favorites: readonly string[] }>;

let state: State = { favorites: [] };
let loadStarted = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

async function load() {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const favorites = (JSON.parse(raw) as { favorites?: unknown }).favorites;
    if (Array.isArray(favorites)) {
      const loaded = favorites.filter((id): id is string => typeof id === 'string');
      // Merge, so a star tapped before the disk read finished is not lost.
      state = { favorites: Array.from(new Set([...loaded, ...state.favorites])) };
      emit();
    }
  } catch {
    // Unreadable/corrupt prefs just mean "no stars yet".
  }
}

function subscribe(cb: () => void) {
  void load();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function toggleMailFavorite(mailId: string): void {
  const favorites = state.favorites.includes(mailId)
    ? state.favorites.filter((id) => id !== mailId)
    : [...state.favorites, mailId];
  state = { favorites };
  emit();
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => undefined);
}

export function useMailPrefs() {
  const snap = useSyncExternalStore(subscribe, () => state, () => state);
  return useMemo(() => ({ isFavorite: (mailId: string) => snap.favorites.includes(mailId) }), [snap]);
}
