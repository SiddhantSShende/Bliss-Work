import { useTranslation } from "react-i18next";
import { Forward } from "lucide-react";
import { externalForwardProvenanceText, externalPlatformDisplayName } from "../lib/externalForward";
import { SystemPill } from "./SystemPill";

/**
 * The in-thread record that a message was handed off to an external app —
 * WhatsApp today, and per externalForward.ts's ACTIVE_EXTERNAL_FORWARD_PLATFORMS
 * the only one that can ever trigger this component in the current product.
 *
 * It renders from an ordinary message of kind `forward_external`, which only
 * the server can post (store/forward_link.go) — a client cannot forge this
 * kind by typing the right sentence into the composer. What CAN vary is how
 * much of the text is trusted-but-generic versus trusted-and-specific:
 *
 *   - `platform` is the normalized destination (messages/channel_messages.
 *     forward_platform — migrations/0032_forward_platform.sql), set
 *     server-side and never client-supplied. The primary line is derived from
 *     it via externalForwardProvenanceText rather than stored as prose, so
 *     this component stays generic: a future destination is a new `platform`
 *     value, not a new hardcoded string here.
 *   - `body` is the OPTIONAL recipient fragment the server composed
 *     (store/forward_link.go's linkPillDetail) — "to Jane (+1234567890)" in a
 *     DM, empty in the common case. Still pre-rendered text rather than props
 *     to format here, for the same reason as before: the server decides what
 *     each surface may disclose (a DM shows a phone number, a channel does
 *     not — a channel can have dozens of readers who were never given that
 *     third party's number), and this component must not re-derive that
 *     policy from data it cannot fully see.
 *   - A pill written BEFORE this column existed has no `platform` (NULL in
 *     the database) and falls back to rendering its old, fully pre-rendered
 *     `body` verbatim — see the `platform` fallback branch below.
 *
 * ── Why it does not say "forwarded" ──────────────────────────────────────────
 * A wa.me deep link opens WhatsApp with the text prefilled and ends our
 * visibility. The user may never press send, may switch contacts inside
 * WhatsApp, or may cancel, and WhatsApp never calls back to say which. So the
 * wording is "Message forwarded to WhatsApp" plus an explicit "not confirmed"
 * marker on the ORIGINAL author's copy — never "Delivered" or "Sent", which
 * would claim an outcome nobody observed.
 *
 * The author is the one who needs the marker: at depth 1 the peer of a DM *is*
 * the person whose message left the workspace. The forwarder does not get
 * it — they were just there, and they know what they did or didn't press.
 */
export function ForwardBadge({
  body,
  at,
  /** True on the forwarder's own copy. Controls only the unconfirmed marker. */
  mine,
  /** messages/channelMessages[].forwardPlatform — absent on a pill written
   *  before this field existed, which falls back to rendering `body` as-is. */
  platform,
}: {
  body: string;
  at?: string;
  mine: boolean;
  platform?: string;
}) {
  const { t } = useTranslation("chatList");
  return (
    <SystemPill
      icon={<Forward size={12} className="text-accent" />}
      at={at}
      title={
        platform
          ? t("forwardBadge.titleWithPlatform", { brand: "BlissWork", platform: externalPlatformDisplayName(platform) })
          : t("forwardBadge.titleWhatsapp", { brand: "BlissWork" })
      }
    >
      {platform ? (
        <>
          {externalForwardProvenanceText(platform)}
          {body && ` ${body}`}
        </>
      ) : (
        body
      )}
      {!mine && <span className="text-warning">{t("forwardBadge.notConfirmed")}</span>}
    </SystemPill>
  );
}
