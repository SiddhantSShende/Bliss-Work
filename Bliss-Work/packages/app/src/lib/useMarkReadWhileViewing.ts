import { useEffect, useMemo, useRef, useState } from "react";

const isViewing = () => document.visibilityState === "visible" && document.hasFocus();

/** True while the user can actually SEE this document: the tab is visible and
 *  the window has focus. Messages that arrive in a background tab, or behind
 *  another window, have not been read. */
export function useIsViewing(): boolean {
  const [viewing, setViewing] = useState(isViewing);
  useEffect(() => {
    const update = () => setViewing(isViewing());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return viewing;
}

/**
 * Report how far the reader has got in a thread — but only while they are
 * looking at it, and only when the newest message actually changed.
 *
 * Gating on visibility/focus stops a hidden tab from marking messages read (the
 * sender would see a false "Seen"); coming back to the tab re-fires once, which
 * is what catches up on everything that arrived meanwhile. Keying on the
 * highest `seq` rather than the message count means prepending an older page,
 * which changes the count but not what the reader has seen, posts nothing.
 */
export function useMarkReadWhileViewing(
  scopeId: string,
  messages: ReadonlyArray<{ seq: number }>,
  markRead: (upToSeq: number) => void,
): void {
  const viewing = useIsViewing();
  const maxSeq = useMemo(() => messages.reduce((m, x) => Math.max(m, x.seq), 0), [messages]);
  // Latest closure, without making a new function every render a dependency.
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;

  useEffect(() => {
    if (!viewing || maxSeq === 0) return;
    markReadRef.current(maxSeq);
  }, [viewing, maxSeq, scopeId]);
}
