import type { MessageStatus } from "@taskboard/shared";

/**
 * Per-message delivery state, rendered next to the timestamp on the SENDER'S
 * own bubbles — text, media, files and shared locations alike, because the
 * caller renders this beneath the bubble rather than inside it.
 *
 * It used to be a tick mark: one grey check for SENT, two for DELIVERED, two
 * accent-coloured for SEEN. Nobody could tell those apart at 12px, and the
 * difference between "it arrived" and "they read it" is the entire point of
 * showing anything at all — so the state is now spelled out:
 *
 *   PENDING   → "Sending…"   (not yet 201)
 *   SENT      → "Sent"        (server stored it)
 *   DELIVERED → "Delivered"   (recipient's gateway pushed it)
 *   SEEN      → "Seen"        (recipient called /read) — accented
 *
 * An ABSENT status renders nothing. That is not the same as PENDING: a surface
 * with no delivery model at all (channel messages carry no `status` — there is
 * no per-member read cursor behind them) would otherwise have shown every one
 * of the sender's own messages as permanently "Sending…".
 *
 * The component is presentation-only; the caller decides which status to pass
 * based on the sender-side cache state.
 */
export function MessageStatusBadge({
  status,
  className = "",
}: {
  status: MessageStatus | undefined;
  className?: string;
}) {
  if (!status) return null;

  const label =
    status === "PENDING" ? "Sending…" :
    status === "SENT" ? "Sent" :
    status === "DELIVERED" ? "Delivered" :
    "Seen";

  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}
      title={label}
      aria-label={label}
    >
      {/* Separates the label from the timestamp the caller renders beside it,
          so the row reads "14:32 · Seen" rather than "14:32Seen". */}
      <span aria-hidden className="opacity-50">·</span>
      <span className={status === "SEEN" ? "font-medium text-accent" : "opacity-90"}>
        {label}
      </span>
    </span>
  );
}
