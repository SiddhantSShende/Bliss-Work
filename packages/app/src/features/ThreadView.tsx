import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { motion } from "framer-motion";
import { MessageSquare, ChevronUp, Loader2, PhoneMissed } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import type { MessageDTO } from "@taskboard/shared";
import { clock, groupMessages } from "../lib/chatFormat";
import { MessageStatusBadge } from "./MessageStatusBadge";

interface ThreadMsgVisual {
  id: string;
  senderId: string;
  senderName?: string;
  body: string;
  at?: string;
  pending?: boolean;
  status?: MessageDTO["status"];
  /** System entries (a missed call) render as a centered notice, not a bubble. */
  kind?: MessageDTO["kind"];
}

/**
 * Reverse-infinite-scroll email-style thread renderer. Replaces the message
 * list portion of ChatThread for the new Inbox UX while ChatThread itself
 * keeps wrapping it for DMView/ChannelView (no breakage).
 *
 * Pagination contract:
 *   `messages` is sorted ASCENDING by seq.
 *   `hasMore` true → user can ask for the previous page.
 *   `onLoadMore()` returns a promise; while pending we show a small loader at
 *   the top. Scroll position is anchored on `scrollHeight` BEFORE the prepend
 *   so the user's view doesn't jump.
 *
 * Why anchor manually instead of using scrollIntoView (which the old
 * ChatThread had to abandon — see comment there): scrollIntoView walks up
 * every scrollable ancestor including the overflow-hidden shell, shoving the
 * navbar off-screen.
 */
export function ThreadView({
  messages,
  meId,
  hasMore,
  onLoadMore,
  isFetchingPrev,
  showSenderNames = false,
  renderBody,
}: {
  messages: ThreadMsgVisual[];
  meId: string;
  hasMore: boolean;
  onLoadMore: () => void;
  isFetchingPrev: boolean;
  showSenderNames?: boolean;
  /** Optional override for a message's body cell (e.g. file-offer bubbles).
   *  Returns null to fall back to the default text bubble. */
  renderBody?: (m: ThreadMsgVisual) => ReactNode | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const lastMsgIdRef = useRef<string | null>(null);
  const anchorHeightRef = useRef<number | null>(null);

  // Auto-scroll to bottom when a new message lands at the END of the array.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const tail = messages[messages.length - 1];
    if (!tail) return;
    if (tail.id !== lastMsgIdRef.current) {
      lastMsgIdRef.current = tail.id;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  // Anchor scrollHeight before a prepend so the prepended page doesn't
  // visually displace the user's current scroll position.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const anchor = anchorHeightRef.current;
    if (anchor != null) {
      el.scrollTop = el.scrollHeight - anchor;
      anchorHeightRef.current = null;
    }
  }, [messages]);

  const onTopReached = () => {
    const el = listRef.current;
    if (!el || !hasMore || isFetchingPrev) return;
    anchorHeightRef.current = el.scrollHeight - el.scrollTop;
    onLoadMore();
  };

  return (
    <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-auto p-5"
         onScroll={(e) => {
           if ((e.target as HTMLDivElement).scrollTop < 64) onTopReached();
         }}>
      {/* Top loader / "Load older" CTA */}
      {hasMore && (
        <div className="flex justify-center pb-2">
          {isFetchingPrev ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-[11px] text-muted">
              <Loader2 size={12} className="animate-spin" /> Loading older messages…
            </span>
          ) : (
            <button
              onClick={onTopReached}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1 text-[11px] font-medium text-muted hover:text-fg"
              title="Load previous 12 messages"
            >
              <ChevronUp size={12} /> Load previous 12
            </button>
          )}
        </div>
      )}

      {messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <MessageSquare size={24} />
          </div>
          <div className="text-sm">No messages yet — say hi 👋</div>
        </div>
      ) : (
        groupMessages(messages).map(({ msg: m, day, grouped }) => {
          // Guard on a truthy meId so a briefly-missing session id can't
          // right-align the whole thread; received messages default to the left.
          const mine = !!meId && m.senderId === meId;
          const dayChip = day && (
            <div className="my-3 flex justify-center">
              <span className="rounded-full bg-surface-2 px-3 py-0.5 text-[11px] font-medium text-muted">{day}</span>
            </div>
          );

          // A missed call is a fact about the conversation, not something either
          // side said — so it sits centered between the bubbles rather than
          // taking a side. Both members see the same row.
          if (m.kind === "call_missed") {
            return (
              <div key={m.id}>
                {dayChip}
                <div className="my-2 flex justify-center">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-[11px] font-medium text-muted ring-1 ring-border/60">
                    <PhoneMissed size={12} className="text-red-500" />
                    {mine ? `${m.body} · no answer` : m.body}
                    <span className="text-muted/70">{clock(m.at)}</span>
                  </span>
                </div>
              </div>
            );
          }

          return (
            <div key={m.id}>
              {dayChip}
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16 }}
                className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"} ${grouped ? "mt-0.5" : "mt-2"}`}
              >
                {!mine && showSenderNames && (
                  <div className="w-7 shrink-0">
                    {!grouped && <Avatar name={m.senderName || "?"} size="sm" />}
                  </div>
                )}
                <div className={`flex max-w-[72%] flex-col ${mine ? "items-end" : "items-start"}`}>
                  {!mine && showSenderNames && !grouped && (
                    <div className="mb-0.5 ml-1 text-xs font-medium text-muted">{m.senderName}</div>
                  )}
                  {renderBody?.(m) ?? (
                    <div
                      className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow-[0_2px_10px_-4px_rgba(40,30,90,0.25)] ${
                        mine
                          ? "rounded-br-md bg-gradient-to-br from-brand-from to-brand-to text-accent-fg"
                          : "rounded-bl-md bg-surface text-fg ring-1 ring-border/60"
                      } ${m.pending ? "opacity-60" : ""}`}
                    >
                      {m.body}
                    </div>
                  )}
                  <span className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-muted/70">
                    {m.pending ? "Sending…" : clock(m.at)}
                    {mine && !m.pending && <MessageStatusBadge status={m.status} />}
                  </span>
                </div>
              </motion.div>
            </div>
          );
        })
      )}
    </div>
  );
}
