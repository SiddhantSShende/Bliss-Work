import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { readablePrefix } from "@taskboard/app/chatEnvelope";
import { followStoredLocale, useTranslation } from "@taskboard/app/i18n/windowLocale";
import "@taskboard/ui/styles.css";
import "./index.css";
import { type ChatMsg, markSendFailed, mergeIncoming, tempIdFor } from "../shared/sticky-chat-messages";

interface Bootstrap {
  threadId: string;
  conversationId: string;
  myUserId: string;
  peerUserId: string;
  peerUsername: string;
}

declare global {
  interface Window {
    stickyChat: {
      threadId: string;
      onBootstrap: (cb: (b: Bootstrap) => void) => () => void;
      onMessage: (cb: (m: ChatMsg) => void) => () => void;
      onSendFailed: (cb: (clientMsgId: string) => void) => () => void;
      send: (p: { threadId: string; body: string; clientMsgId: string }) => void;
      unpin: (threadId: string) => void;
      ready: () => void;
    };
  }
}

function uuid() {
  return crypto.randomUUID();
}

/**
 * Sticky-chat renderer. Lives inside a frameless transparent always-on-top
 * Electron window. Renders the most recent messages of a pinned thread and
 * a one-line composer. The window is fully draggable via the .app-drag
 * region on its header bar.
 *
 * The renderer does NOT open its own WebSocket — that would duplicate the
 * single utility-process WS connection. Instead it receives messages via
 * IPC ("sticky-chat:message") which the main process forwards from
 * ws-process whenever a MessageCreated lands for a pinned threadId.
 */
function StickyChatApp() {
  const { t } = useTranslation("stickies");
  const { t: tThread } = useTranslation("chatThread");
  useEffect(() => {
    document.title = t("window.titles.chat");
  }, [t]);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const offBoot = window.stickyChat.onBootstrap(setBoot);
    const offMsg = window.stickyChat.onMessage((m) => setMessages((prev) => mergeIncoming(prev, m)));
    const offFailed = window.stickyChat.onSendFailed((clientMsgId) =>
      setMessages((prev) => markSendFailed(prev, clientMsgId)),
    );
    // Ask main to (re)push the bootstrap now that both listeners are live, in
    // case its did-finish-load push raced ahead and was dropped.
    window.stickyChat.ready();
    return () => {
      offBoot();
      offMsg();
      offFailed();
    };
  }, []);

  // Scroll to bottom when a new message lands.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const t = text.trim();
    if (!t || !boot) return;
    const clientMsgId = uuid();
    // Optimistic local bubble — disambiguated by clientMsgId-prefixed id.
    const localId = tempIdFor(clientMsgId);
    setMessages((prev) => [
      ...prev,
      {
        id: localId,
        senderId: boot.myUserId,
        body: t,
        createdAt: new Date().toISOString(),
        clientMsgId,
      },
    ]);
    window.stickyChat.send({ threadId: boot.threadId, body: t, clientMsgId });
    setText("");
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
  };

  if (!boot) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
        {t("window.chat.loadingThread")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-surface shadow-widget">
      <div className="app-drag flex items-center justify-between border-b border-border/60 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fg">{boot.peerUsername}</div>
          <div className="truncate text-[10px] text-muted">{t("window.chat.pinnedChat")}</div>
        </div>
        <button
          className="app-no-drag rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-danger"
          title={t("window.chat.unpinTitle")}
          onClick={() => window.stickyChat.unpin(boot.threadId)}
        >
          {t("window.chat.unpin")}
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-1.5 overflow-auto px-3 py-2">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            {t("window.chat.noMessages")}
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.senderId === boot.myUserId;
            return (
              <div
                key={m.id}
                className={`flex flex-col ${mine ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[80%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl px-3 py-1.5 text-[13px] text-fg shadow-[0_2px_8px_-3px_rgba(40,30,90,0.25)] ${
                    mine ? "rounded-br-md bg-bubble-sent" : "rounded-bl-md bg-bubble-received"
                  } ${m.failed ? "ring-1 ring-danger" : "ring-1 ring-border/60"} ${m.id.startsWith("temp:") && !m.failed ? "opacity-60" : ""}`}
                >
                  {/* Attachments and shared locations carry a JSON envelope
                      after a U+001F sentinel. This window is fed over IPC under
                      `connect-src 'none'`, so it can never load the image — show
                      the readable summary ("🖼️ photo.jpg · 2.0 MB") instead of
                      printing the raw envelope at the user. */}
                  {readablePrefix(m.body)}
                </div>
                {m.failed && (
                  <div role="alert" className="mt-0.5 text-[10px] text-danger">
                    {tThread("shared.messageFailedToSend")}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="app-no-drag border-t border-border/60 bg-surface/50 p-2"
      >
        <div className="flex items-end gap-1.5">
          <textarea
            ref={taRef}
            rows={1}
            placeholder={t("window.chat.replyPlaceholder")}
            className="max-h-[80px] min-h-[36px] flex-1 resize-none rounded-xl border border-border bg-surface px-3 py-1.5 text-[13px] leading-relaxed text-fg placeholder:text-muted/70 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const ta = taRef.current;
              if (ta) {
                ta.style.height = "0px";
                ta.style.height = `${Math.min(ta.scrollHeight, 80)}px`;
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="h-9 shrink-0 rounded-xl bg-gradient-to-br from-brand-from via-brand-mid to-brand-to px-3 text-[12px] font-medium text-accent-fg disabled:opacity-40"
          >
            {t("window.chat.send")}
          </button>
        </div>
      </form>
    </div>
  );
}

void followStoredLocale();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StickyChatApp />
  </React.StrictMode>,
);
