import { useCallback, useRef } from "react";
import { useRuntime } from "./runtime";
import { downloadAttachment } from "./download";

/**
 * A second press on the same file inside this window is the same intent, not a
 * second download: a double-click would otherwise save "file (1).pdf" and write
 * two activity rows. Long enough to cover a double-click and a nervous
 * re-press, short enough that a deliberate later download is never swallowed.
 */
export const DOWNLOAD_COOLDOWN_MS = 1500;

/**
 * The explicit Download of a received mail's attachment.
 *
 * Starts the browser download through the shared `downloadAttachment` (the
 * viewer's own signed URL plus `?dl=1`, which the server turns into
 * `Content-Disposition: attachment`) and then tells the server it was started,
 * so it lands in the admin-facing activity timeline. Preview and Open never go
 * through here, so they are never counted as downloads.
 *
 * The record is "download initiated", not byte-level completion: the bytes come
 * from the signed GET, which this does not observe. Reporting is
 * fire-and-forget — failing to record never blocks or undoes a download that
 * has already started.
 *
 * Mail has no conversation to post a notice into, so this is deliberately not
 * `useAttachmentActivity` (which writes a chat message and patches message
 * caches). Nothing is sent to the mail's sender.
 */
export function useMailAttachmentDownload(mailId: string) {
  const { api } = useRuntime();
  // Last accepted press per attachment id. A time window rather than an
  // in-flight flag: the report settles in tens of milliseconds, far inside a
  // double-click, so "still in flight" would not catch the second click.
  const lastPress = useRef(new Map<string, number>());

  return useCallback(
    (item: { id: string; name: string }, url: string) => {
      const now = Date.now();
      const last = lastPress.current.get(item.id);
      if (last !== undefined && now - last < DOWNLOAD_COOLDOWN_MS) return;
      lastPress.current.set(item.id, now);

      downloadAttachment(url, item.name);
      api
        .recordMailAttachmentDownload(mailId, item.id)
        .catch((err) => console.error("[mail-attachment-download] failed to record", err));
    },
    [api, mailId],
  );
}
