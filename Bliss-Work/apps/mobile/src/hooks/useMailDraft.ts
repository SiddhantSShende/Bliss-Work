import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/**
 * Mobile port of packages/app/src/features/useMailDraft.ts (same contract, same
 * endpoints). Not imported from there because that file pulls in the web
 * router-bound query registry.
 *
 * A server-side draft is opened when the composer opens; what is typed is
 * written back after a pause and once more on close. Leaving without sending
 * KEEPS a non-empty draft (it shows in Drafts) and discards an untouched one.
 */
const AUTOSAVE_DELAY_MS = 1500;

export type MailDraftContent = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  /** A draft holding only files is still worth keeping (web's useMailDraft does the same). */
  hasAttachments?: boolean;
};

export type MailDraftState = {
  mailId?: string;
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
  save: (content: MailDraftContent) => void;
  /** Call on a successful send so the close neither saves nor discards. */
  markSent: () => void;
  discard: () => Promise<void>;
};

function isEmpty(c: MailDraftContent): boolean {
  return !c.hasAttachments && !c.subject.trim() && !c.bodyText.trim() && [...c.to, ...c.cc, ...c.bcc].every((a) => !a.trim());
}

function fingerprint(c: MailDraftContent): string {
  return JSON.stringify([c.to, c.cc, c.bcc, c.subject, c.bodyText]);
}

export function useMailDraft(existingId?: string): MailDraftState {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [mailId, setMailId] = useState<string | undefined>(existingId);
  const [isError, setIsError] = useState(false);
  const [attempt, setAttempt] = useState(0);

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

  const persist = useCallback(
    async (id: string) => {
      const content = contentRef.current;
      if (!content) return;
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
        // Best-effort: the composer still holds every keystroke and the close writes again.
        void pendingRef.current?.then((id) => persist(id)).catch(() => undefined);
      }, AUTOSAVE_DELAY_MS);
    },
    [persist],
  );

  const discard = useCallback(async () => {
    sentRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    const pending = pendingRef.current;
    if (!pending) return;
    const id = await pending;
    await api.discardMailDraft(id);
    void qc.invalidateQueries({ queryKey: qk.mailInbox });
  }, [api, qc]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      if (!pending || sentRef.current) return;
      void pending
        .then(async (id) => {
          const content = contentRef.current;
          if (!content || isEmpty(content)) await api.discardMailDraft(id);
          else await persist(id);
          void qc.invalidateQueries({ queryKey: qk.mailInbox });
        })
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
