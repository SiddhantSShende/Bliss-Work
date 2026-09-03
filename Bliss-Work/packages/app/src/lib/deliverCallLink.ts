/**
 * Minting a call link and delivering it.
 *
 * Lives outside DMView because it is the part with rules: which call shape can
 * carry a link, who ends up on the roster, and what happens when one recipient
 * cannot be messaged. The view keeps the toasts and the cache invalidation.
 */
import { meetingJoinUrl } from "./meetingDeepLink";

/** Only what this needs from the API client, so a test can pass three stubs. */
type CallLinkApi = {
  scheduleMeeting: (body: {
    title?: string;
    media?: "audio" | "video";
    scheduledAt?: string;
    inviteeIds?: string[];
  }) => Promise<{ id: string }>;
  createCallInvite: (callId: string) => Promise<{ token: string }>;
  sendMessage: (recipientId: string, body: string) => Promise<unknown>;
};

type CallLinkResult = {
  /** The join URL. The caller posts this into the conversation itself. */
  link: string;
  /** How many of `alsoTo` could not be messaged. */
  failed: number;
};

/**
 * Open a call in this chat and deliver its link.
 *
 * A link only means anything on a MEETING: a channel call's roster is the
 * channel and a direct call's is the two ends of the chat, and the server
 * refuses to mint one for either. So this creates a meeting with the peer
 * already on the roster — they see it under Meetings too, not only as a URL —
 * and takes the token, which is returned exactly once.
 *
 * `alsoTo` are org members chosen by the sender. They are handled the same two
 * ways the peer is, and for the same reasons: on the roster so the call turns up
 * in their Meetings, and sent the link itself so it reaches them without their
 * having to go looking. A direct message rather than a notification because a
 * direct message is what the peer gets, and one recipient should not hold a
 * worse copy of the same link than another.
 *
 * Cross-org members cannot be passed here: the server rejects an invitee from
 * another org, which is why the picker offers the caller's org alone. The LINK
 * is the cross-org path, and it stays the only one.
 *
 * No scheduledAt, so the call is live the moment this resolves — which is the
 * point of a link.
 */
export async function deliverCallLink(
  api: CallLinkApi,
  {
    peerId,
    peerName,
    alsoTo,
    origin,
  }: { peerId: string; peerName: string; alsoTo: string[]; origin: string },
): Promise<CallLinkResult> {
  const call = await api.scheduleMeeting({
    title: `Call with ${peerName}`,
    media: "video",
    inviteeIds: [peerId, ...alsoTo],
  });
  const invite = await api.createCallInvite(call.id);
  const link = meetingJoinUrl(origin, invite.token);
  // allSettled, not all: one recipient who cannot be messaged — they blocked the
  // sender, say — must not cost everyone else the link. By this point the
  // meeting exists and the token has already been spent, so there is nothing to
  // roll back and the honest outcome is to deliver what can be delivered and
  // report the rest.
  const results = await Promise.allSettled(
    alsoTo.map((id) => api.sendMessage(id, `Join my call: ${link}`)),
  );
  return { link, failed: results.filter((r) => r.status === "rejected").length };
}
