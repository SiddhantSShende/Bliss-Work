/**
 * The generic rendering layer for a forward that left BlissWork entirely.
 *
 * `message_forwards.platform` (and its denormalized twin, MessageDTO/
 * ChannelMessageDTO.forwardPlatform — see migrations/0032_forward_platform.sql)
 * is a normalized identifier, never a display label: the server writes
 * "whatsapp", not "WhatsApp". Every place that needs the human-readable name —
 * today just ForwardBadge — goes through `externalPlatformDisplayName` so
 * there is exactly one map from identifier to label in the whole app, and
 * adding a destination later means adding one entry here, not teaching every
 * caller a new string.
 *
 * The schema and this display map both already list five platforms (headroom
 * for whenever a connected-account integration exists for the others — see
 * integrations-svc's orphaned /internal/messages/send), but only WhatsApp is
 * an actual forwarding destination a user can pick today — hardcoded as its
 * own anchor in MessageActions/useWhatsAppForward.ts, not driven by a generic
 * list here. A badge deciding what to DISPLAY still reads the full map below,
 * because a message forwarded to WhatsApp last month must still render
 * correctly even after a second destination becomes pickable.
 */
import i18n from "../i18n";

/** Matches the CHECK constraint on message_forwards.platform (and the newer
 *  messages/channel_messages.forward_platform) — the full set the schema can
 *  represent, not the set currently reachable from the UI. */
export type ExternalForwardPlatform = "whatsapp" | "slack" | "teams" | "gmail" | "outlook";

const PLATFORM_DISPLAY_NAMES: Record<ExternalForwardPlatform, string> = {
  whatsapp: "WhatsApp",
  slack: "Slack",
  teams: "Microsoft Teams",
  gmail: "Gmail",
  outlook: "Outlook",
};

function isKnownPlatform(platform: string): platform is ExternalForwardPlatform {
  return Object.prototype.hasOwnProperty.call(PLATFORM_DISPLAY_NAMES, platform);
}

/**
 * The human-readable name for a normalized platform identifier.
 *
 * Falls back to the raw value (never throws, never renders blank) for a
 * platform this build does not recognize yet — an old client reading a value
 * a newer server started writing degrades to showing that value verbatim
 * rather than crashing the thread, the same wire-tolerance chatEnvelope.ts and
 * MessageKindWire already apply to an unrecognized kind/envelope.
 */
export function externalPlatformDisplayName(platform: string): string {
  return isKnownPlatform(platform) ? PLATFORM_DISPLAY_NAMES[platform] : platform;
}

/** "Message forwarded to WhatsApp" — the provenance line ForwardBadge renders
 *  from trusted (server-set) metadata rather than from text stored in the
 *  message body. */
export function externalForwardProvenanceText(platform: string): string {
  return i18n.t("chatList:forwardBadge.messageForwardedTo", {
    platform: externalPlatformDisplayName(platform),
  });
}
