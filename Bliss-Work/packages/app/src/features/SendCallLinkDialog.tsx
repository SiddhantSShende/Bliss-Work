import { useState } from "react";
import { Button } from "@taskboard/ui";
import { Modal } from "./Modal";
import { InviteePicker } from "./InviteePicker";

/**
 * Who receives the call link.
 *
 * "Send Call Link" posted the link into this chat and nowhere else, so the chat
 * was the only way anyone could be reached with it. The link was never the
 * limitation — a meeting link admits anyone signed in to BlissWork — the missing
 * part was somewhere to say who else should get it.
 *
 * The chat peer is not in the list and cannot be deselected: the link is posted
 * in the chat, so they have it by definition. Sending with nothing selected is
 * therefore exactly what this control did before, which is why the submit button
 * is never disabled on an empty selection.
 */
export function SendCallLinkDialog({
  open,
  onClose,
  peerName,
  exclude,
  busy = false,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  peerName: string;
  /** Already certain to get the link — the peer. */
  exclude: Set<string>;
  /** A link is being minted and delivered. */
  busy?: boolean;
  onSend: (userIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Send a call link">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          The link is posted in your chat with {peerName}. Anyone you add here gets it as a direct
          message, and holds a seat in the call under Meetings.
        </p>

        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">
            Also send to{" "}
            <span className="font-normal">
              {selected.size > 0 ? `— ${selected.size} selected` : "— optional"}
            </span>
          </span>
          <InviteePicker selected={selected} onToggle={toggle} exclude={exclude} />
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} onClick={() => onSend([...selected])}>
            Send link
          </Button>
        </div>
      </div>
    </Modal>
  );
}
