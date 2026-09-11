import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'muted_conversations_v1';

/**
 * Per-device "Mute Notifications" — there is no server-side mute API today
 * (muting is a personal notification preference, not conversation state
 * other participants need to see), so this persists to AsyncStorage the same
 * way web's equivalent (packages/app/src/lib/conversationPrefs.ts) persists
 * to localStorage, and the same way ThemeProvider.tsx persists its own
 * device-local preference on mobile.
 */
export function useMutedConversations() {
  const [muted, setMuted] = useState<Set<string>>(new Set());

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => setMuted(new Set(raw ? (JSON.parse(raw) as string[]) : [])))
      .catch(() => setMuted(new Set()));
  }, []);

  const toggle = useCallback((conversationId: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);

  const isMuted = useCallback((conversationId: string) => muted.has(conversationId), [muted]);

  return { isMuted, toggle };
}
