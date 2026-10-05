import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { NOTIFICATION_MESSAGE_PARAM, validUuid } from "./notificationDestination";

/**
 * The message a chat or channel was opened to land on (`?m=<messageId>`, put there
 * by a notification click), and a way to drop it once the thread has scrolled there.
 *
 * Dropped with `replace`, so Back does not walk through it — and so clicking the
 * same notification again re-adds it and re-focuses. Only a UUID counts; anything
 * else in the URL is ignored, never searched for.
 */
export function useMessageFocus(): { messageId: string | null; clear: () => void } {
  const [params, setParams] = useSearchParams();
  const messageId = validUuid(params.get(NOTIFICATION_MESSAGE_PARAM));
  const clear = useCallback(
    () =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete(NOTIFICATION_MESSAGE_PARAM);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  return { messageId, clear };
}
