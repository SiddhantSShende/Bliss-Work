import { linkifyMessage } from "../lib/chatFormat";

/**
 * A message body with any URLs — a call link chief among them — rendered as
 * clickable anchors. `target="_blank"` + `rel="noopener noreferrer"` matches
 * every other external link in the app (MessageActions, ChatAssetsSheet, …).
 * Never markup: `linkifyMessage` hands back plain-text/link segments, and
 * each one becomes a text child, exactly like `{m.body}` used to.
 *
 * Shared by every message-bubble renderer (ChatThread, ThreadView) so the
 * two don't drift the way they once did — see chatFormat.ts's `linkifyMessage`
 * for the underlying splitting logic.
 */
export function renderMessageBody(body: string) {
  return linkifyMessage(body).map((seg, i) =>
    seg.type === "link" ? (
      <a
        key={i}
        href={seg.value}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-current/40 underline-offset-2 hover:decoration-current"
      >
        {seg.value}
      </a>
    ) : (
      <span key={i}>{seg.value}</span>
    ),
  );
}
