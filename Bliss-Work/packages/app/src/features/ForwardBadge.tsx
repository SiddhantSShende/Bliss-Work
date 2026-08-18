import { Forward } from "lucide-react";
import { SystemPill } from "./SystemPill";

/**
 * The in-thread record that a message was handed to WhatsApp.
 *
 * It renders from an ordinary message of kind `forward_external` whose body was
 * authored SERVER-SIDE (store/forward_link.go's linkPillBody), which is what
 * makes it trustworthy: a client cannot post this kind, so the row cannot be
 * forged by typing the right sentence into the composer. That is also why the
 * number and name arrive as pre-rendered text rather than as props to format
 * here — the server decides what each surface is allowed to disclose (a DM shows
 * the phone number, a channel does not, because a channel can have dozens of
 * readers who were never given that third party's number).
 *
 * ── Why it does not say "forwarded" ──────────────────────────────────────────
 * A wa.me deep link opens WhatsApp with the text prefilled and ends our
 * visibility. The user may never press send, may switch contacts inside
 * WhatsApp, or may cancel, and WhatsApp never calls back to say which. So the
 * wording is "Opened WhatsApp to forward this to …", and the ORIGINAL author's
 * copy carries an explicit "not confirmed" marker.
 *
 * The author is the one who needs it: at depth 1 the peer of a DM *is* the
 * person whose message left the workspace, and telling them "forwarded" would
 * assert something nobody observed. The forwarder does not get the marker —
 * they were just there, and they know what they did or didn't press.
 */
export function ForwardBadge({
  body,
  at,
  /** True on the forwarder's own copy. Controls only the unconfirmed marker. */
  mine,
}: {
  body: string;
  at?: string;
  mine: boolean;
}) {
  return (
    <SystemPill
      icon={<Forward size={12} className="text-accent" />}
      at={at}
      title="BlissWork opened WhatsApp with the message prefilled. Whether it was sent isn't something we can observe."
    >
      {body}
      {!mine && <span className="text-amber-500">· not confirmed</span>}
    </SystemPill>
  );
}
