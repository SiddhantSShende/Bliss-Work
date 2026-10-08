import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'muted_conversations_v1';

async function readMutedConversations(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch (error) {
    console.warn('Could not read muted conversations from storage', error);
    return new Set();
  }
}

/** Used by the WebSocket notification path, which is outside the screen hook. */
export async function isConversationMuted(conversationId: string): Promise<boolean> {
  return (await readMutedConversations()).has(conversationId);
}

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
    void readMutedConversations().then(setMuted);
  }, []);

  const toggle = useCallback((conversationId: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...next])).catch((error) => {
        console.warn('Could not save muted conversations to storage', error);
      });
      return next;
    });
  }, []);

  const isMuted = useCallback((conversationId: string) => muted.has(conversationId), [muted]);

  return { isMuted, toggle };
}
