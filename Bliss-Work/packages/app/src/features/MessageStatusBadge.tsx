import { Check, CheckCheck, Clock } from "lucide-react";
import type { MessageStatus } from "@taskboard/shared";

/**
 * Tiny per-message delivery state badge. Rendered next to the timestamp on
 * the SENDER'S own bubbles. The colour ramps from muted → accent as the
 * message moves through the wire:
 *
 *   PENDING   → outline clock        (not yet 201)
 *   SENT      → single grey check     (server stored)
 *   DELIVERED → double grey check     (recipient gateway pushed)
 *   SEEN      → double accent check   (recipient called /read)
 *
 * The component is presentation-only; the caller decides which status to
 * pass based on the sender-side cache state.
 */
export function MessageStatusBadge({
  status,
  className = "",
}: {
  status: MessageStatus | undefined;
  className?: string;
}) {
  const s = status ?? "PENDING";
  const title =
    s === "PENDING" ? "Sending…" :
    s === "SENT" ? "Sent" :
    s === "DELIVERED" ? "Delivered" :
    "Seen";
  return (
    <span className={`inline-flex items-center ${className}`} title={title} aria-label={title}>
      {s === "PENDING" && <Clock size={12} className="opacity-50" />}
      {s === "SENT" && <Check size={12} className="opacity-60" />}
      {s === "DELIVERED" && <CheckCheck size={12} className="opacity-60" />}
      {s === "SEEN" && <CheckCheck size={12} className="text-accent" />}
    </span>
  );
}
