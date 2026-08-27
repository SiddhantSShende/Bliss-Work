/**
 * The chat panel's body: what the room says in writing, while it carries on
 * talking. The tab bar, export and close controls live one level up in
 * CallSidePanel — this renders only the message list and the composer.
 *
 * ── "To:" is the whole feature ───────────────────────────────────────────────
 * A message goes to Everyone or to one person, and the difference has to be
 * legible BEFORE it is sent — the moment you have to check afterwards is the
 * moment somebody has already sent the wrong thing to the wrong people. So the
 * selector sits directly above the box, the placeholder repeats the choice, and
 * a private message is tinted and labelled in the transcript.
 *
 * Privacy is enforced on the wire, not here: a direct message is addressed to
 * one identity and the SFU delivers it to nobody else (see lib/callChat).
 *
 * No attachments here — meeting chat has no server copy and no upload path
 * (see lib/callChat's file doc), so the attachment button is disabled rather
 * than wired to nothing. No reactions either: nothing in ChatEntry carries
 * them today, so there is nothing yet for a reaction row to render.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Paperclip, Send } from "lucide-react";
import { Avatar, Button, cn } from "@taskboard/ui";
import { EmojiPickerButton } from "./EmojiPicker";
import { CHAT_TEXT_MAX, type ChatEntry } from "../lib/callChat";
import type { RoomParticipant } from "../lib/useCallRoom";

/** The "to" value meaning everyone. `null` is the wire value; the <select>
 *  needs a string, and "" is the one that cannot collide with an identity. */
const EVERYONE = "";

export function CallChat({
  chat,
  participants,
  me,
  onSend,
}: {
  chat: readonly ChatEntry[];
  participants: readonly RoomParticipant[];
  /** This client's identity, so our own messages sit on the right. */
  me: string;
  onSend: (text: string, to: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState<string>(EVERYONE);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  /** Everyone else in the room — you cannot send yourself a private message. */
  const others = useMemo(
    () => participants.filter((p) => !p.isLocal && p.identity),
    [participants],
  );
  const nameOf = useMemo(() => {
    const byId = new Map(participants.map((p) => [p.identity, p.name]));
    return (id: string) => byId.get(id) ?? id;
  }, [participants]);

  // The person you were writing to can leave. Falling back to Everyone would
  // silently widen the audience of a message you meant for one person, so this
  // clears the DRAFT's destination and says so by reverting the selector.
  useEffect(() => {
    if (to !== EVERYONE && !others.some((p) => p.identity === to)) setTo(EVERYONE);
  }, [others, to]);

  // Follow the tail. A message written while you are reading should arrive in
  // view, not below the fold. Scrolls THIS container directly — never
  // scrollIntoView, which walks up and scrolls the whole app shell.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text.slice(0, CHAT_TEXT_MAX), to === EVERYONE ? null : to);
    setDraft("");
  };

  const privateTo = to === EVERYONE ? null : nameOf(to);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 border-b border-border/70 px-4 py-2 text-[11px] text-muted">
        Messages here are visible to all meeting members — pick a name below to send one privately.
      </p>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {chat.length === 0 ? (
          <p className="pt-6 text-center text-xs text-muted">
            No messages yet. Anything sent here lives for the length of the meeting — download
            it from the header if you need to keep it.
          </p>
        ) : (
          chat.map((c) => <ChatBubble key={c.id} entry={c} mine={c.from === me} nameOf={nameOf} />)
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-border/70 p-3">
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <span className="shrink-0">To:</span>
          <select
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label="Who this message goes to"
            className={`min-w-0 flex-1 rounded-lg border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-accent ${
              privateTo ? "border-warning/60 text-warning" : "border-border text-fg"
            }`}
          >
            <option value={EVERYONE}>Everyone</option>
            {others.map((p) => (
              <option key={p.identity} value={p.identity}>
                {p.name} (private)
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-end gap-1">
          {/* Disabled rather than omitted: the composer's shape stays the same
              whether or not a given room supports it — see CallControls. */}
          <button
            type="button"
            disabled
            title="Attachments aren't supported in meeting chat"
            aria-label="Attachments aren't supported in meeting chat"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Paperclip size={18} />
          </button>
          <EmojiPickerButton
            onPick={(emoji) => {
              // Appended rather than inserted at the caret — same reasoning as
              // the app's main Composer: the textarea is uncontrolled from the
              // picker's side, so reaching into its selection buys nothing.
              setDraft((d) => d + emoji);
              requestAnimationFrame(() => taRef.current?.focus());
            }}
          />
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line — the same rule as every
              // other composer in the app, because it is the same gesture.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={CHAT_TEXT_MAX}
            rows={1}
            placeholder={privateTo ? `Private message to ${privateTo}…` : "Message everyone…"}
            aria-label={privateTo ? `Private message to ${privateTo}` : "Message everyone"}
            className="max-h-[100px] min-h-[44px] min-w-0 flex-1 resize-none rounded-2xl border border-border bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-muted/70 focus:border-accent"
          />
          <Button
            size="icon"
            className="h-11 w-11 shrink-0 rounded-full"
            onClick={submit}
            disabled={!draft.trim()}
            title="Send"
          >
            <Send size={16} />
          </Button>
        </div>

        {privateTo && (
          <span className="inline-flex items-center gap-1 text-[11px] text-warning">
            <Lock size={10} />
            Only {privateTo} will see this
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One message.
 *
 * The body is a text child — never markup, never dangerouslySetInnerHTML. That
 * is the app-wide rule and it matters most here, where the content is written
 * by another participant's client.
 */
function ChatBubble({
  entry,
  mine,
  nameOf,
}: {
  entry: ChatEntry;
  mine: boolean;
  nameOf: (id: string) => string;
}) {
  const isPrivate = entry.to !== null;
  return (
    <div className={cn("flex items-end gap-2", mine && "flex-row-reverse")}>
      <Avatar name={mine ? "You" : entry.fromName} size="sm" />
      <div
        className={cn(
          "max-w-[75%] rounded-xl px-3 py-2",
          isPrivate
            ? "bg-warning/10 ring-1 ring-warning/30"
            : mine
              ? "bg-accent-soft"
              : "bg-surface-2",
        )}
      >
        <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
          <span className={cn("truncate font-medium", mine ? "text-fg" : "text-accent")}>
            {mine ? "You" : entry.fromName}
          </span>
          <span className="shrink-0 tabular-nums">
            {new Date(entry.at).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </div>
        {isPrivate && (
          // Said on every private message, on both sides. The sender needs to
          // know it stayed private; the recipient needs to know the room did
          // not see it before they reply to it in front of everyone.
          <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium text-warning">
            <Lock size={9} />
            {mine ? `Private to ${nameOf(entry.to!)}` : "Private to you"}
          </div>
        )}
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg">{entry.text}</p>
      </div>
    </div>
  );
}
