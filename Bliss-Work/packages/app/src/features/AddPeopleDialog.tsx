import { useState } from "react";
import { toast } from "sonner";
import { Modal } from "./Modal";
import { MemberPicker } from "./MemberPicker";

/**
 * "Add People" from inside a call.
 *
 * The picker itself is the one the channel members sheet uses — same directory,
 * same search, same exclusion set — because "choose teammates" should not be a
 * different control depending on which screen asked.
 *
 * Adding someone to a ONE-TO-ONE call is not just a roster change: two people
 * are on a peer connection, and a third has nowhere to go on it, so the call
 * moves to the room at the same moment. That is why a failure here has to be
 * reported rather than swallowed — `onAdd` rejecting means nobody was added and
 * the call is still the call it was.
 */
export function AddPeopleDialog({
  open,
  onClose,
  exclude,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  /** Who is already on the call. */
  exclude: Set<string>;
  onAdd: (userIds: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = (ids: string[]) => {
    setBusy(true);
    onAdd(ids)
      .then(() => {
        toast.success(ids.length > 1 ? `Added ${ids.length} people` : "Added to the call");
        onClose();
      })
      .catch((e: unknown) =>
        toast.error("Couldn't add anyone to this call", {
          description:
            e instanceof Error && e.message
              ? e.message
              : "Group calling may not be available on this server.",
        }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Add people to this call">
      <MemberPicker exclude={exclude} busy={busy} onConfirm={confirm} onCancel={onClose} />
    </Modal>
  );
}
