import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/** How long the composer stays quiet before a change is written to the server. */
const AUTOSAVE_DELAY_MS = 1500;

/** Everything the composer would lose if the draft were not saved. */
export type MailDraftContent = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  /** Files already uploaded against this draft. They are saved by the upload
   *  itself, but they decide whether the draft counts as EMPTY on close. */
  hasAttachments: boolean;
};

export type MailDraftState = {
  /** The draft id, once the server has created it (immediate when resuming). */
  mailId?: string;
  isLoading: boolean;
  isError: boolean;
  /** Re-attempt after a failure. */
  retry: () => void;
  /** The composer's current contents. Written to the server after a pause, and
   *  once more when the composer closes. */
  save: (content: MailDraftContent) => void;
  /** Call on a successful send so the draft is NOT saved or discarded on unmount. */
  markSent: () => void;
  /** Throw this draft away now — the explicit Discard control. */
  discard: () => Promise<void>;
};

/** Is there anything here worth keeping? */
function isEmpty(c: MailDraftContent): boolean {
  return (
    !c.hasAttachments &&
    !c.subject.trim() &&
    !c.bodyText.trim() &&
    [...c.to, ...c.cc, ...c.bcc].every((a) => !a.trim())
  );
}

/** What was last written, for skipping a save that would change nothing. */
function fingerprint(c: MailDraftContent): string {
  return JSON.stringify([c.to, c.cc, c.bcc, c.subject, c.bodyText]);
}

/**
 * Acquires the server-side draft the composer writes into, keeps it up to date,
 * and decides what happens to it when the composer goes away.
 *
 * ── Why a draft exists at all ────────────────────────────────────────────────
 * An attachment upload has to be authorized against a destination that already
 * exists (attachments.scope='mail', scope_id=this id), so the destination must
 * be created before the user picks a file — which in practice means when the
 * composer opens.
 *
 * ── What closing the composer does ───────────────────────────────────────────
 * Whatever a mail client does: an unsent mail with anything in it is KEPT, and
 * shows up in Drafts; an untouched one is discarded, because every composer
 * open creates a row and a mailbox full of blank drafts is a mailbox full of
 * evidence that somebody pressed New Mail. Discarding is also what an emptied
 * draft gets — clearing a draft out is how a mail client is told to forget it.
 *
 * ── Why this is not a react-query call ───────────────────────────────────────
 * It is not cacheable server state, it is a RESOURCE whose lifetime is this
 * component's. The distinction matters at exactly one moment: closing the
 * composer while creation is still in flight. A cache read at cleanup time
 * would see no id yet and leak the row that lands a moment later; holding the
 * promise lets the release wait for the resource it is releasing.
 *
 * @param existingId resume this draft instead of opening a new one — the id
 *                   from /app/mail/compose/:draftId. Nothing is created and
 *                   nothing is discarded that the user did not empty first.
 */
export function useMailDraft(existingId?: string): MailDraftState {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [mailId, setMailId] = useState<string | undefined>(existingId);
  const [isError, setIsError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The in-flight creation, so cleanup can await it rather than miss it. A
  // resumed draft is already resolved — the id came in on the URL.
  const pendingRef = useRef<Promise<string> | null>(null);
  const sentRef = useRef(false);
  const contentRef = useRef<MailDraftContent | null>(null);
  const savedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (existingId) {
      pendingRef.current = Promise.resolve(existingId);
      setMailId(existingId);
      return;
    }
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
  }, [api, attempt, existingId]);

  // One definition of "write it now", used by the debounce and by the close.
  const persist = useCallback(
    async (id: string) => {
      const content = contentRef.current;
      if (!content) return;
      // Nothing has been written and nothing has been typed: the composer was
      // opened and left alone, which is not a save — it is a request that would
      // fire on every New Mail before the user reached the first field.
      if (isEmpty(content) && savedRef.current === null) return;
      const print = fingerprint(content);
      if (print === savedRef.current) return;
      await api.saveMailDraft(id, content);
      savedRef.current = print;
    },
    [api],
  );

  const save = useCallback(
    (content: MailDraftContent) => {
      contentRef.current = content;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        // Autosave is best-effort by design: the composer still holds every
        // keystroke, the close writes again, and a toast per dropped packet
        // would interrupt the writing it is meant to protect.
        void pendingRef.current?.then((id) => persist(id)).catch(() => undefined);
      }, AUTOSAVE_DELAY_MS);
    },
    [persist],
  );

  const discard = useCallback(async () => {
    sentRef.current = true; // Nothing left for the close to save.
    if (timerRef.current) clearTimeout(timerRef.current);
    const pending = pendingRef.current;
    if (!pending) return;
    const id = await pending;
    await api.discardMailDraft(id);
    void qc.invalidateQueries({ queryKey: qk.mailDrafts });
  }, [api, qc]);

  // Close: keep what was written, drop what was not. Deliberately depends on
  // nothing that changes per keystroke — it reads the refs at the moment it
  // runs, so it is registered once and cannot fire early.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      if (!pending || sentRef.current) return;
      void pending
        .then(async (id) => {
          const content = contentRef.current;
          if (!content || isEmpty(content)) {
            await api.discardMailDraft(id);
          } else {
            await persist(id);
          }
          // The Drafts folder is frequently on screen BESIDE the composer, so
          // it has to be told. Only here and on discard: invalidating on every
          // autosave would refetch that list every couple of seconds while the
          // user types.
          void qc.invalidateQueries({ queryKey: qk.mailDrafts });
        })
        // Best-effort: a draft that survives a failed cleanup is still the
        // user's own unsent mail, and an empty one that survives is filtered
        // out of the Drafts listing server-side.
        .catch(() => undefined);
    },
    [api, persist, qc],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const markSent = useCallback(() => {
    sentRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { mailId, isLoading: !mailId && !isError, isError, retry, save, markSent, discard };
}
