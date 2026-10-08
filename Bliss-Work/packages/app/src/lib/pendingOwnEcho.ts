/**
 * Is this message event just the echo of a send still in flight in THIS tab?
 *
 * The sender's own socket receives its own `message.created`, and the open
 * thread already shows that message as an optimistic `temp:` row which the
 * send's 201 swaps for the real id (useOptimisticSend). Appending the echo as
 * well would render it twice until the swap, so the bridge skips it — but ONLY
 * while such a row exists. The same user's message sent from another tab or
 * device (or a forward / missed-call notice posted on their behalf) has no
 * temp row here and must be appended, or it never shows up live.
 *
 * The event carries no handle on the temp row (`clientMsgId` is minted inside
 * the API call), so the match is the sender plus the body. A different body
 * from another device is therefore appended, and an identical body sent from
 * two devices at once is the one case this skips (the next refetch shows it).
 */
export function isPendingOwnEcho(
  rows: ReadonlyArray<{ id: string; senderId: string; body: string }> | undefined,
  senderId: string,
  body: string,
): boolean {
  const wanted = body.trim();
  return !!rows?.some(
    (m) => m.id.startsWith("temp:") && m.senderId === senderId && m.body.trim() === wanted,
  );
}
