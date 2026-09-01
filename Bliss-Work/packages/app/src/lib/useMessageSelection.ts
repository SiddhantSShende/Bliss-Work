import { useCallback, useEffect, useState } from "react";
import { useToggleSet } from "./useToggleSet";

/**
 * Multi-message selection for one conversation or channel.
 *
 * Keyed by stable message id, never index: an older page prepended by
 * useOlderMessages shifts every index in the array and shifts nothing here.
 *
 * Resets on `scopeId` — the same hazard useOlderMessages guards against.
 * DMView/ChannelView are NEVER remounted on a conversation switch (React
 * Router reuses them across a param change), so a selection that lived
 * anywhere else would follow the user into the next chat and offer to delete
 * messages they are no longer looking at. It resets HERE, in one place,
 * rather than in each view's own reset effect — see DMView/ChannelView's own
 * `useEffect([conversationId|channelId])` blocks, which already carry a
 * pointer comment back to this hook.
 */
export function useMessageSelection(scopeId: string) {
  const [active, setActive] = useState(false);
  const { selected, setSelected, toggle } = useToggleSet();

  // setSelected/setActive are useState setters, so both are referentially
  // stable — which is what lets `exit`/`enter` be effect dependencies without
  // re-running the effect below on every render.
  const exit = useCallback(() => {
    setActive(false);
    setSelected(new Set());
  }, [setSelected]);

  const enter = useCallback(() => {
    setSelected(new Set());
    setActive(true);
  }, [setSelected]);

  useEffect(() => {
    exit();
    // Only scopeId should trigger a reset — exit's identity never changes
    // (see above), and including it would be redundant, not incorrect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId]);

  // Escape leaves selection mode, matching every other dismissible surface
  // in this app (menus, popups).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, exit]);

  return { active, selected, toggle, enter, exit, count: selected.size } as const;
}
