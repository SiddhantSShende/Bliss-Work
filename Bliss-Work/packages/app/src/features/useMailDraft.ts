import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "../lib/runtime";

export type MailDraftState = {
  /** The draft id, once the server has created it. */
  mailId?: string;
  isLoading: boolean;
  isError: boolean;
  /** Re-attempt after a failure. */
  retry: () => void;
  /** Call on a successful send so the draft is NOT discarded on unmount. */
  markSent: () => void;
};

/**
 * Acquires the server-side draft the composer writes into, and releases it when
 * the composer goes away.
 *
 * ── Why a draft exists at all ────────────────────────────────────────────────
 * An attachment upload has to be authorized against a destination that already
 * exists (attachments.scope='mail', scope_id=this id), so the destination must
 * be created before the user picks a file — which in practice means when the
 * composer opens. The draft is invisible until sent: nothing projects it into
 * anyone's feed.
 *
 * ── Why this is not a react-query call ───────────────────────────────────────
 * It is not cacheable server state, it is a RESOURCE whose lifetime is this
 * component's. The distinction matters at exactly one moment: closing the
 * composer while creation is still in flight. A cache read at cleanup time
 * would see no id yet and leak the row that lands a moment later; holding the
 * promise lets the release wait for the resource it is releasing.
 */
export function useMailDraft(): MailDraftState {
  const { api } = useRuntime();
  const [mailId, setMailId] = useState<string | undefined>(undefined);
  const [isError, setIsError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The in-flight creation, so cleanup can await it rather than miss it.
  const pendingRef = useRef<Promise<string> | null>(null);
  const sentRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setIsError(false);
    const promise = api.createMailDraft().then((res) => res.mailId);
    pendingRef.current = promise;
    promise.then(
      (id) => {
        if (alive) setMailId(id);
      },
      () => {
        pendingRef.current = null;
        if (alive) setIsError(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  // Release on unmount — but only if the mail never left. A sent mail is no
  // longer a draft, and asking the server to discard it would 409 (and if that
  // ever stopped being true, it would delete a mail other people already have).
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (!pending) return;
      void pending
        .then((id) => (sentRef.current ? undefined : api.discardMailDraft(id)))
        // Best-effort: an abandoned draft that survives a failed cleanup is
        // invisible anyway, and its attachments are expiring-by-default.
        .catch(() => undefined);
    },
    [api],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const markSent = useCallback(() => {
    sentRef.current = true;
  }, []);

  return { mailId, isLoading: !mailId && !isError, isError, retry, markSent };
}
