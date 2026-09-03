/**
 * May the caller delete this message FOR EVERYONE?
 *
 * The DM rule is author-only; a channel widens it to its moderators. Extracted
 * so the bulk-selection toolbar and its confirm dialog answer the same
 * question ChatThread already asks per-message (`mine || !!canModerate`)
 * instead of keeping a second copy that could drift. The server re-checks
 * regardless — this only decides what to OFFER.
 */
export function canDeleteForAll(
  msg: { senderId: string },
  meId: string,
  canModerate?: boolean,
): boolean {
  // Guard on a truthy meId: if the session id is briefly missing, never treat
  // a message as the caller's own — mirrors ChatThread's own `mine` guard.
  return (!!meId && msg.senderId === meId) || !!canModerate;
}

/**
 * May the caller moderate this channel: remove anyone's message, pin for
 * everyone, manage its roster? `channel.myRole` is the caller's own standing
 * in THIS channel; an org_admin moderates every channel without needing to be
 * a member of it, which is the same rule requireChannelManager applies
 * server-side. The server re-checks regardless — this only decides what to
 * OFFER.
 */
export function canModerateChannel(
  channel: { myRole?: string } | undefined,
  me: { roles?: string[] },
): boolean {
  return (
    channel?.myRole === "owner" ||
    channel?.myRole === "admin" ||
    !!me.roles?.includes("org_admin")
  );
}
