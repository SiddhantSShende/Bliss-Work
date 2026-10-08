/**
 * Pure pieces of the pinned-chat window's message feed, shared by the
 * ws-process (which relays server events and sends replies) and the sticky-chat
 * renderer (which owns the bubble list). Kept free of Electron so both sides —
 * and the tests — can use it.
 */

export interface ChatMsg {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
  /** The sender's idempotency key. The server echo of a message sent from this
   *  window carries the same one, which is how the optimistic bubble is matched. */
  clientMsgId?: string;
  /** Optimistic bubble whose send failed (renderer-only). */
  failed?: boolean;
}

const MAX_MESSAGES = 50;

/** Id of the optimistic bubble shown while a reply is in flight. */
export const tempIdFor = (clientMsgId: string) => `temp:${clientMsgId}`;

/** The slice of a `message.created` event the pinned-chat window renders. */
export function toStickyChatMessage(e: {
  messageId: string;
  senderId: string;
  body: string;
  occurredAt: string;
  clientMsgId?: string;
}): ChatMsg {
  return {
    id: e.messageId,
    senderId: e.senderId,
    body: e.body,
    createdAt: e.occurredAt,
    clientMsgId: e.clientMsgId,
  };
}

/**
 * Fold a message arriving over IPC into the feed. A server echo of our own
 * reply replaces its optimistic bubble in place (matched by clientMsgId);
 * anything already present by id is ignored; the rest is appended.
 */
export function mergeIncoming(prev: ChatMsg[], m: ChatMsg): ChatMsg[] {
  if (prev.some((x) => x.id === m.id)) return prev;
  if (m.clientMsgId) {
    const temp = tempIdFor(m.clientMsgId);
    if (prev.some((x) => x.id === temp)) return prev.map((x) => (x.id === temp ? m : x));
  }
  return [...prev, m].slice(-MAX_MESSAGES);
}

/** Flag the optimistic bubble for `clientMsgId` as failed to send. */
export function markSendFailed(prev: ChatMsg[], clientMsgId: string): ChatMsg[] {
  const temp = tempIdFor(clientMsgId);
  return prev.map((x) => (x.id === temp ? { ...x, failed: true } : x));
}

/**
 * Send a reply from the pinned-chat window and report a failure instead of
 * swallowing it. `reply` is the ApiClient call; `onFailed` tells the window.
 */
export async function sendStickyChatReply(
  reply: ((threadId: string, body: string, opts: { clientMsgId: string }) => Promise<unknown>) | undefined,
  req: { threadId: string; body: string; clientMsgId: string },
  onFailed: (threadId: string, clientMsgId: string) => void,
): Promise<void> {
  try {
    if (!reply) throw new Error("not signed in");
    await reply(req.threadId, req.body, { clientMsgId: req.clientMsgId });
  } catch {
    onFailed(req.threadId, req.clientMsgId);
  }
}
