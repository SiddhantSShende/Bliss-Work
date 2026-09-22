import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Ban, Check, Forward, PhoneMissed, Pin, Camera } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Avatar } from "@taskboard/ui";
import { clock, groupMessages } from "../lib/chatFormat";
import type { ChannelReadReceiptDTO, MessageDTO, ReactionDTO } from "@taskboard/shared";
import { parseChatEnvelope, readablePrefix, type MediaItem } from "../lib/chatEnvelope";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { useUserLabels } from "../lib/userLabel";
import { waForwardText, waShareLink } from "../lib/waLink";
import { useWhatsAppMediaForward } from "../lib/useWhatsAppMediaForward";
import { Composer } from "./Composer";
import { SystemPill } from "./SystemPill";
import { ForwardBadge } from "./ForwardBadge";
import { MessageStatusBadge } from "./MessageStatusBadge";
import { MessageActions, ReactionChips } from "./MessageActions";
import { renderMessageBody } from "./messageBody";

export interface ThreadMessage {
  id: string;
  senderId: string;
  senderName?: string;
  body: string;
  at?: string;
  pending?: boolean;
  /** System entries (a missed call, a forward handed off to WhatsApp, a refused
   *  screenshot) render as a centered notice, not a bubble. */
  kind?: "text" | "call_missed" | "forward_external" | "screenshot_attempt";
  /** Sender-side delivery state. Set only on the caller's own messages. */
  status?: MessageDTO["status"];
  /** The message this one quotes. Rendered as a strip above the body. */
  replyToId?: string;
  /** Deleted for everyone: render a tombstone, not the body (which is empty). */
  deletedForAll?: boolean;
  /** This message's reaction tally, from the caller's point of view. */
  reactions?: ReactionDTO[];
  /** A copy delivered by forwarding someone else's message. Labelled above the
   *  bubble — the same content under the forwarder's name with no marker
   *  attributes it to them. */
  isForward?: boolean;
  /** Set only when `kind` is "forward_external" — the normalized destination
   *  (MessageDTO.forwardPlatform / ChannelMessageDTO.forwardPlatform) the
   *  ForwardBadge derives its "Message forwarded to X" line from. */
  forwardPlatform?: string;
  /** Pinned for everyone in the channel. Channels only; DMs never set it. */
  pinned?: boolean;
  /** Who has read this one. CHANNELS only — a DM's equivalent is `status`,
   *  which has a single answer because there is a single reader. */
  channelReceipts?: ChannelReadReceiptDTO[];
}

/** Is the caller already reacting with this emoji? Drives whether a tap on the
 *  quick row adds or removes, so the same gesture toggles. */
function minePressed(m: ThreadMessage, emoji: string): boolean {
  return !!m.reactions?.some((r) => r.emoji === emoji && r.mine);
}

/**
 * The quote strip above a reply's body.
 *
 * A media or location quote uses `readablePrefix` rather than the raw body —
 * the body of an attachment message is an envelope, and quoting it verbatim
 * would print JSON at the reader. An unresolved id (the quoted message is
 * older than the loaded page, or was deleted) still renders a strip: "you are
 * replying to something" is information, and silence would make the reply look
 * like a non-sequitur.
 */
function isSingleEmoji(body: string): boolean {
  const value = body.trim();
  if (!value || typeof Intl.Segmenter !== "function") return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(value);
}

function quoted(m: ThreadMessage, byId: Map<string, ThreadMessage>, t: TFunction) {
  if (!m.replyToId) return null;
  const src = byId.get(m.replyToId);
  const text = src
    ? src.deletedForAll
      ? t("thread.deletedMessage")
      : readablePrefix(src.body) || src.body
    : t("thread.originalMessage");
  return (
    <div className="mb-1 border-l-2 border-current/40 pl-2 text-xs opacity-75">
      {src?.senderName && <div className="font-medium">{src.senderName}</div>}
      <div className="line-clamp-2 break-words">{text}</div>
    </div>
  );
}

/**
 * "Seen by N" under a channel message, and the list behind it.
 *
 * A channel has no single peer, so the DM's Sent/Delivered/Seen badge has
 * nothing to say here — "seen" is a different number for every member. This
 * answers the question the badge cannot: exactly who has read this one.
 *
 * Rendered ONLY on the caller's own messages, and only in channels — see where
 * ChannelView builds `channelReceipts`. The sender is never counted among the
 * readers (the store excludes them), so a message with nobody else caught up
 * has no receipts and this renders nothing at all rather than "Seen by 0".
 */
function SeenBy({ receipts }: { receipts: ChannelReadReceiptDTO[] }) {
  const { t } = useTranslation("chatThread");
  const [open, setOpen] = useState(false);
  const wrap = usePopupDismiss<HTMLSpanElement>(open, () => setOpen(false));
  if (receipts.length === 0) return null;
  return (
    <span ref={wrap} className="relative inline-flex">
      <span aria-hidden className="opacity-50">·</span>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="ml-1 font-medium text-accent hover:underline"
        aria-expanded={open}
        aria-label={t("thread.seenBy.ariaLabel", { count: receipts.length })}
      >
        {t("thread.seenBy.count", { count: receipts.length })}
      </button>
      {open && (
        // Keep the reader list below its trigger so it does not cover the
        // message text. Anchored to the RIGHT edge, not the left: this only
        // ever renders on the caller's own messages (see the file doc), which
        // sit against the right edge of the thread — opening from the left
        // edge of the trigger pushed the panel further right, off the
        // visible column, on exactly the messages it appears on.
        <span
          role="dialog"
          aria-label={t("thread.seenBy.label")}
          className="absolute right-0 top-full z-[1000] mt-1 max-h-48 min-w-40 overflow-y-auto rounded-lg border border-border bg-surface p-2 text-xs text-fg shadow-card"
        >
          <span className="mb-1 block font-semibold">{t("thread.seenBy.label")}</span>
          {receipts.map((receipt) => (
            <span key={receipt.readerId} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="truncate">{receipt.readerName || t("thread.seenBy.unknownReader")}</span>
              {receipt.readAt && (
                <span className="shrink-0 tabular-nums text-muted">{clock(receipt.readAt)}</span>
              )}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** Presentational chat thread (bubbles + composer). Reused by DMs and channels. */
export function ChatThread({
  threadId,
  messages,
  meId,
  onSend,
  onType,
  peerTyping = false,
  peerName,
  showSenderNames = false,
  placeholder,
  disabled = false,
  notice,
  onForwardTo,
  onForward,
  onReply,
  onHide,
  onMarkUnread,
  onDeleteForAll,
  canModerate,
  onTogglePin,
  onReact,
  replyTo,
  onCancelReply,
  renderBody,
  onAttach,
  onShareLocation,
  onPaste,
  dropzone,
  dragging = false,
  attachments,
  onRemoveAttachment,
  uploading,
  overlay,
  onLoadOlder,
  loadingOlder = false,
  hasOlder = false,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  selectionToolbar,
}: {
  /**
   * Conversation/channel id. ChatThread is never remounted on a chat switch
   * (DMView/ChannelView are unkeyed — see their own comments on why), so
   * without this the scroll-tracking refs below would carry over from
   * whatever chat was open before, misreading the new chat's first paint as
   * "a message got appended to the old one" and animating a visible scroll.
   */
  threadId: string;
  messages: ThreadMessage[];
  meId: string;
  onSend: (text: string) => void;
  /**
   * When provided, each non-pending bubble offers "Forward to chat or
   * channel…", which delivers the message inside the workspace (attachments
   * included — the server re-scopes them).
   */
  onForwardTo?: (messageId: string) => void;
  /**
   * When provided, each non-pending bubble offers "Forward to WhatsApp".
   *
   * The navigation itself is the anchor's own doing (see MessageActions); this
   * only ARMS the record on the same click. The recipient is chosen inside
   * WhatsApp, so there is nothing to capture here and no second entry.
   *
   * When the message carries attachments, this component ALSO fires the
   * media hand-off (useWhatsAppMediaForward) from the same click — a separate,
   * un-awaited call, never one that could delay or risk the anchor's own
   * synchronous navigation. See that hook for what it can and cannot actually
   * deliver to WhatsApp.
   */
  onForward?: (messageId: string) => void;
  /** Start a reply quoting this message. */
  onReply?: (messageId: string) => void;
  /** "Delete for me" — hides it for the caller only. */
  onHide?: (messageId: string) => void;
  /** Marks the selected message and everything after it as unread. */
  onMarkUnread?: (messageId: string) => void;
  /** "Delete for everyone" — the menu hides it on others' messages unless
   *  `canModerate` says the caller may remove anyone's. */
  onDeleteForAll?: (messageId: string) => void;
  /**
   * The caller moderates this surface (channel owner / admin / org_admin), and
   * so may delete other people's messages here.
   *
   * One flag for the whole thread rather than a per-message predicate: the
   * capability is a property of the caller's role in the channel, not of any
   * individual message, and threading a callback through every bubble to answer
   * the same question would be the same answer N times.
   */
  canModerate?: boolean;
  /** Pin/unpin a message for everyone. Absent where pinning does not apply
   *  (DMs) or where the caller may not moderate. */
  onTogglePin?: (messageId: string, pinned: boolean) => void;
  /** Toggle one emoji reaction on a message. */
  onReact?: (messageId: string, emoji: string, on: boolean) => void;
  /** The message currently being quoted — renders the composer's reply bar. */
  replyTo?: ThreadMessage | null;
  onCancelReply?: () => void;
  /**
   * Escape hatch for structured bodies (attachments, shared locations). Return
   * null to fall through to the plain text bubble. Mirrors ThreadView's hook so
   * both surfaces render the same things.
   */
  renderBody?: (m: ThreadMessage) => React.ReactNode | null;
  /** Composer affordances — hidden when not supplied. */
  onAttach?: () => void;
  onShareLocation?: () => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  /** Drag-and-drop handlers for the whole surface, from useChatMedia. */
  dropzone?: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  dragging?: boolean;
  /** Staged-attachment tray, straight from useChatMedia. */
  attachments?: MediaItem[];
  onRemoveAttachment?: (id: string) => void;
  uploading?: number;
  /** Portal-ish extras rendered alongside the thread (the lightbox). */
  overlay?: React.ReactNode;
  /** Called on every local keystroke (drives the typing indicator). */
  onType?: () => void;
  /** True while the peer is typing — renders the animated "…" bubble. */
  peerTyping?: boolean;
  peerName?: string;
  showSenderNames?: boolean;
  placeholder?: string;
  /** When true, the composer is replaced by a `notice` banner (e.g. blocked). */
  disabled?: boolean;
  /** Message shown in place of the composer when `disabled` (e.g. "You blocked
   *  this user"). */
  notice?: string;
  /** Fetch the previous page of history. Called when the reader nears the top. */
  onLoadOlder?: () => void;
  /** True while an older page is in flight — suppresses repeat triggers. */
  loadingOlder?: boolean;
  /** False once the server returns a short page, i.e. we hold the whole history. */
  hasOlder?: boolean;
  /**
   * When true, every selectable bubble shows a selection indicator instead of
   * its normal actions, and `selectionToolbar` replaces the composer. Absent
   * or false: current behaviour, unchanged.
   */
  selectionMode?: boolean;
  /** The currently-selected message ids. Only consulted while `selectionMode`. */
  selectedIds?: ReadonlySet<string>;
  /** Toggle one message's selection. Required, alongside `selectedIds`, for
   *  `selectionMode` to actually render indicators — both are optional props
   *  so every existing caller that omits them keeps today's behaviour. */
  onToggleSelect?: (messageId: string) => void;
  /** Replaces the composer while `selectionMode` is on, exactly as `notice`
   *  replaces it while `disabled`. Rendered rather than built here because the
   *  bulk actions it offers depend on permissions this presentational
   *  component has no way to know. */
  selectionToolbar?: React.ReactNode;
}) {
  const { t } = useTranslation("chatThread");
  const listRef = useRef<HTMLDivElement>(null);
  const forwardMedia = useWhatsAppMediaForward();

  // Index for resolving a reply's quoted message, over the pages currently
  // held. A quote whose target predates the loaded window renders via the
  // message's own replyTo* fields instead.
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // Sender avatars resolved live rather than trusted from `senderName` (which,
  // like the DM/channel row it comes from, can lag a change) — shared by both
  // callers, so this covers a DM's one peer and a channel's whole roster.
  const { avatarUrlOf } = useUserLabels(useMemo(() => messages.map((m) => m.senderId), [messages]));

  // Scroll management, doing two jobs that fight each other.
  //
  // Appending (a new message arrived) should pin the reader to the bottom.
  // PREPENDING (an older page loaded) must not: the container grows upward, so
  // leaving scrollTop alone visibly throws the reader backwards, and the old
  // scroll-to-bottom-on-length-change would have yanked them to the newest
  // message mid-scroll. Distinguishing the two by comparing the first and last
  // ids is what makes back-pagination usable.
  //
  // We scroll the container DIRECTLY rather than calling endRef.scrollIntoView():
  // the latter walks up and scrolls EVERY scrollable ancestor — including the
  // overflow-hidden app shell (still scrollable programmatically) — which shoved
  // the whole UI up and pushed the top navbar off-screen.
  //
  // useLayoutEffect, not useEffect: the correction must land in the same frame
  // as the taller list, or the jump is visible.
  //
  // Keyed by threadId, not just message ids: DMView/ChannelView never remount
  // ChatThread on a chat switch, so without tracking whose ids these are, a
  // stale-then-fresh cache delivery for a revisited or websocket-preseeded
  // chat gets misread as "message appended to the PREVIOUS chat" and animates
  // a visible smooth-scroll instead of landing instantly.
  //
  // `settledRef` stays false across every render of a thread's opening
  // sequence — not just its very first one — because a revisited or
  // websocket-preseeded chat can deliver a stale cached page and then the
  // fresh one a moment later as two separate renders. Both must land
  // instantly; only scrolls after the thread has visibly settled should
  // animate.
  const prevRef = useRef<{ threadId?: string; firstId?: string; lastId?: string; height: number }>({ height: 0 });
  const settledRef = useRef(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const firstId = messages[0]?.id;
    const lastId = messages[messages.length - 1]?.id;
    const prev = prevRef.current;
    const isNewThread = prev.threadId !== threadId;
    if (isNewThread) settledRef.current = false;
    const prepended = !isNewThread && !!prev.firstId && firstId !== prev.firstId && lastId === prev.lastId;

    if (prepended) {
      el.scrollTop += el.scrollHeight - prev.height;
    } else if (isNewThread || lastId !== prev.lastId) {
      // No smooth scroll while a thread is still settling into view — it
      // should already be at the bottom when it appears, not animate there.
      el.scrollTo({ top: el.scrollHeight, behavior: settledRef.current ? "smooth" : "auto" });
    }
    if (messages.length > 0) settledRef.current = true;
    prevRef.current = { threadId, firstId, lastId, height: el.scrollHeight };
  }, [threadId, messages]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el || !onLoadOlder || !hasOlder || loadingOlder) return;
    if (el.scrollTop < 120) onLoadOlder();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" {...dropzone}>
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-1 overflow-auto p-5"
      >
        {/* History marker. Sits above the first bubble so the reader can tell
            "there is more, fetching it" from "this is where it started". */}
        {messages.length > 0 && (hasOlder || loadingOlder) && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              className="rounded-full px-3 py-1 text-[11px] font-medium text-muted transition-colors hover:text-accent disabled:opacity-60"
            >
              {loadingOlder ? t("thread.loadHistory.loading") : t("thread.loadHistory.load")}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MessageSquare size={24} />
            </div>
            <div className="text-sm">{t("shared.emptyMessages")}</div>
          </div>
        ) : (
          groupMessages(messages).map(({ msg: m, day, grouped }) => {
            // Guard on a truthy meId: if the session id is briefly missing,
            // never treat a message as "mine" (which would right-align the whole
            // thread). A received message must default to the left.
            const mine = !!meId && m.senderId === meId;
            const selecting = selectionMode && !!onToggleSelect;
            // Not everything is selectable. A pending send has a `temp:` id
            // the server has never heard of; a tombstone has nothing left to
            // delete or forward — same exclusions MessageActions already
            // applies to its own render below.
            const selectable = selecting && !m.pending && !m.deletedForAll;
            const picked = !!selectedIds?.has(m.id);
            const dayChip = day && (
              <div className="my-3 flex justify-center">
                <span className="rounded-full bg-surface-2 px-3 py-0.5 text-[11px] font-medium text-muted">{day}</span>
              </div>
            );

            // A missed call is a fact about the conversation, not something
            // either side said — centered, no bubble, no forward action. Both
            // members see the same row; only the caller is told "no answer".
            if (m.kind === "call_missed") {
              return (
                <div key={m.id}>
                  {dayChip}
                  <SystemPill icon={<PhoneMissed size={12} className="text-danger" />} at={m.at}>
                    {mine ? t("shared.callMissedNoAnswer", { body: m.body }) : m.body}
                  </SystemPill>
                </div>
              );
            }

            // A refused screenshot is a fact about the conversation too, and the
            // body already names who tried — nothing to vary between mine/theirs.
            if (m.kind === "screenshot_attempt") {
              return (
                <div key={m.id}>
                  {dayChip}
                  <SystemPill icon={<Camera size={12} className="text-warning" />} at={m.at}>
                    {m.body}
                  </SystemPill>
                </div>
              );
            }

            // Handing a message to WhatsApp is the same class of fact: it left
            // the workspace. The body is authored server-side, and the peer's
            // copy carries the caveat — see ForwardBadge.
            if (m.kind === "forward_external") {
              return (
                <div key={m.id}>
                  {dayChip}
                  <ForwardBadge body={m.body} at={m.at} mine={mine} platform={m.forwardPlatform} />
                </div>
              );
            }

            // Structured bodies (attachments, shared locations) render their
            // own bubble; anything else falls through to plain text.
            const custom = renderBody?.(m) ?? null;
            const emojiOnly = !m.replyToId && isSingleEmoji(m.body);

            return (
              <div key={m.id}>
                {dayChip}
                <div
                  className={`flex items-center gap-2 ${
                    selectable
                      ? `-mx-1 cursor-pointer rounded-xl px-1 ${picked ? "bg-accent-soft/40" : "hover:bg-surface-2/50"}`
                      : ""
                  }`}
                  {...(selectable
                    ? {
                        role: "button" as const,
                        tabIndex: 0,
                        "aria-pressed": picked,
                        "aria-label": m.senderName
                          ? t("thread.selectMessageFrom", { name: m.senderName })
                          : t("thread.selectMessage"),
                        onClick: () => onToggleSelect!(m.id),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onToggleSelect!(m.id);
                          }
                        },
                      }
                    : {})}
                >
                  {/* Rendered whenever selection mode is on, even for a message
                      that is not itself selectable (pending, tombstoned) — a
                      transparent ring rather than an absent one, so bubbles
                      don't shift horizontally between selectable and not. */}
                  {selecting && (
                    <span
                      aria-hidden
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 transition-colors ${
                        !selectable
                          ? "ring-transparent"
                          : picked
                            ? "bg-accent text-accent-fg ring-accent"
                            : "text-transparent ring-border"
                      }`}
                    >
                      <Check size={13} />
                    </span>
                  )}
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16 }}
                  className={`flex flex-1 items-end gap-2 ${mine ? "justify-end" : "justify-start"} ${grouped ? "mt-0.5" : "mt-2"}`}
                >
                  {!mine && showSenderNames && (
                    <div className="w-7 shrink-0">{!grouped && <Avatar name={m.senderName || "?"} size="sm" />}</div>
                  )}
                  <div className={`flex ${custom ? "max-w-[85%]" : "max-w-[72%]"} flex-col ${mine ? "items-end" : "items-start"}`}>
                    {!mine && showSenderNames && !grouped && (
                      <div className="mb-0.5 ml-1 text-xs font-medium text-muted">{m.senderName}</div>
                    )}
                    {/* Said once, above the bubble, on both parties' copies:
                        the forwarder needs to know the label is there as much
                        as the reader does. Without it a forwarded photo is
                        indistinguishable from one the sender took. */}
                    {/* A pin nobody can see is not a pin. Marked on the bubble
                        rather than only in the menu, so "pinned for everyone"
                        is visible to everyone without opening anything. */}
                    {m.pinned && !m.deletedForAll && (
                      <div className="mb-0.5 flex items-center gap-1 px-1 text-[11px] font-medium text-accent">
                        <Pin size={11} /> {t("thread.pinned")}
                      </div>
                    )}
                    {m.isForward && !m.deletedForAll && (
                      <div className="mb-0.5 flex items-center gap-1 px-1 text-[11px] italic text-muted">
                        <Forward size={11} /> {t("thread.forwarded")}
                      </div>
                    )}
                    <div className={`group flex items-center gap-1 ${mine ? "flex-row-reverse" : "flex-row"}`}>
                      {m.deletedForAll ? (
                        // A tombstone, not a gap. The body genuinely is not on
                        // the client — the server never decrypts a deleted
                        // message — so there is nothing here to reveal.
                        <div
                          className={`inline-flex items-center gap-1.5 rounded-2xl px-3.5 py-2 text-sm italic ${mine ? "rounded-br-md" : "rounded-bl-md"
                            } bg-surface-2 text-muted ring-1 ring-border/60`}
                        >
                          <Ban size={13} /> {t("thread.tombstone")}
                        </div>
                      ) : custom ? (
                        // pointer-events-none while selecting: a tap on a
                        // photo/file/location must toggle selection (the row's
                        // own click handler), not open the lightbox or a link.
                        <div className={`${m.pending ? "opacity-60" : ""} ${selecting ? "pointer-events-none select-none" : ""}`}>{custom}</div>
                      ) : (
                        <div
                          className={(emojiOnly
                            ? `whitespace-pre-wrap break-words text-4xl leading-none ${m.pending ? "opacity-60" : ""}`
                            : `whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow-[0_2px_10px_-4px_rgba(40,30,90,0.25)] ${mine
                              ? "rounded-br-md bg-gradient-to-br from-brand-from to-brand-to text-accent-fg"
                              : "rounded-bl-md bg-surface text-fg ring-1 ring-border/60"
                              } ${m.pending ? "opacity-60" : ""}`) + (selecting ? " pointer-events-none select-none" : "")}
                        >
                          {quoted(m, byId, t)}
                          {renderMessageBody(m.body)}
                        </div>
                      )}
                      {!m.pending && !m.deletedForAll && !selecting && (
                        <MessageActions
                          mine={mine}
                          // Built here because this is where the body lives.
                          // waForwardText strips the envelope of a structured
                          // body, so an attachment or shared location forwards
                          // as readable text rather than raw JSON.
                          forwardHref={
                            onForward ? waShareLink(waForwardText(m.body)) : undefined
                          }
                          onForwardTo={onForwardTo ? () => onForwardTo(m.id) : undefined}
                          onForward={
                            onForward
                              ? () => {
                                  // Arms the text pill's provenance record — unchanged,
                                  // still the anchor's own synchronous click.
                                  onForward(m.id);
                                  // A SEPARATE, un-awaited call: wa.me cannot carry
                                  // media at all (see useWhatsAppMediaForward), so a
                                  // media message additionally gets a best-effort
                                  // hand-off through the OS share sheet (or a download
                                  // fallback), fired here rather than blocking the
                                  // anchor's own navigation on a network fetch.
                                  const env = parseChatEnvelope(m.body);
                                  if (env?.kind === "media") {
                                    forwardMedia(
                                      env.items.map((it) => ({ id: it.id, name: it.name, mime: it.mime })),
                                      waForwardText(m.body),
                                    );
                                  }
                                }
                              : undefined
                          }
                          onReply={onReply ? () => onReply(m.id) : undefined}
                          onHide={onHide ? () => onHide(m.id) : undefined}
                          onMarkUnread={onMarkUnread ? () => onMarkUnread(m.id) : undefined}
                          onDeleteForAll={onDeleteForAll ? () => onDeleteForAll(m.id) : undefined}
                          canDeleteForAll={mine || !!canModerate}
                          pinned={m.pinned}
                          onTogglePin={
                            onTogglePin ? () => onTogglePin(m.id, !m.pinned) : undefined
                          }
                          onReact={
                            onReact ? (emoji) => onReact(m.id, emoji, !minePressed(m, emoji)) : undefined
                          }
                        />
                      )}
                    </div>
                    {onReact && m.reactions && (
                      <ReactionChips
                        reactions={m.reactions}
                        // Visible but inert while selecting — see the file's
                        // selection-mode notes: normal actions should not fire
                        // from a bubble click during selection.
                        onToggle={(emoji, on) => {
                          if (selecting) return;
                          onReact(m.id, emoji, on);
                        }}
                      />
                    )}
                    <span className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-muted/70">
                      {m.pending ? t("shared.sending") : clock(m.at)}
                      {/* Sent → Delivered → Seen, spelled out, on my own
                          bubbles only — and on every kind of them, because this
                          row sits BELOW the bubble and so covers media, files
                          and shared locations as well as text.

                          DMs only. A channel message carries no `status`: the
                          question "have they read it" has one answer per member
                          there, which is what SeenBy answers instead. The badge
                          renders nothing for an absent status either way. */}
                      {mine && !m.pending && <MessageStatusBadge status={m.status} />}
                      {mine && !m.pending && m.channelReceipts && (
                        <SeenBy receipts={m.channelReceipts} />
                      )}
                    </span>
                  </div>
                </motion.div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {peerTyping && (
        <div className="flex items-center gap-2 px-5 pb-1.5 text-xs text-muted">
          <span className="inline-flex items-end gap-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:-0.2s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:-0.1s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60" />
          </span>
          {peerName ? t("thread.typing.peer", { name: peerName }) : t("thread.typing.generic")}
        </div>
      )}

      {selectionToolbar ? (
        selectionToolbar
      ) : disabled ? (
        <div className="flex items-center justify-center gap-2 border-t border-border/60 bg-surface-2/60 p-4 text-sm text-muted">
          <Ban size={15} className="shrink-0 text-danger" />
          <span>{notice ?? t("thread.disabledNotice")}</span>
        </div>
      ) : (
        <Composer
          // Keyed on threadId: ChatThread is never remounted on a chat switch
          // (DMView/ChannelView are unkeyed — see this component's own
          // threadId doc comment), so without this a draft typed for one
          // conversation would still be sitting in the box — and get sent —
          // after switching to a different one.
          key={threadId}
          onSend={onSend}
          onType={onType}
          onAttach={onAttach}
          onShareLocation={onShareLocation}
          onPaste={onPaste}
          placeholder={placeholder ?? t("thread.composerPlaceholder")}
          dragging={dragging}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          uploading={uploading}
          replyPreview={
            replyTo
              ? {
                who: replyTo.senderName,
                text: replyTo.deletedForAll
                  ? t("thread.deletedMessage")
                  : readablePrefix(replyTo.body) || replyTo.body,
              }
              : undefined
          }
          onCancelReply={onCancelReply}
        />
      )}

      {overlay}
    </div>
  );
}
