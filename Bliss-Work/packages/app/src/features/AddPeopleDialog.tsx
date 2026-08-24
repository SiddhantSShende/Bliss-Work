import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@taskboard/ui";
import { Modal } from "./Modal";
import { MemberPicker } from "./MemberPicker";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";

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
  callId,
}: {
  open: boolean;
  onClose: () => void;
  /** Who is already on the call. */
  exclude: Set<string>;
  onAdd: (userIds: string[]) => Promise<void>;
  callId?: string;
}) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const canSendOrganization = (me?.roles as readonly string[] | undefined)?.some(
    (role) => role === "org_admin" || role === "owner",
  ) ?? false;

  const sendLink = (ids: string[]) => {
    setBusy(true);
    const deliver = callId
      ? api.createCallInvite(callId).then(async ({ token }) => {
          const link = `${window.location.origin}/join?t=${encodeURIComponent(token)}`;
          await onAdd(ids);
          const results = await Promise.allSettled(
            ids.map((id) => api.sendMessage(id, `Join the meeting: ${link}`)),
          );
          const failed = results.filter((result) => result.status === "rejected").length;
          if (failed > 0) {
            toast.warning("Link sent with some exceptions", {
              description: `${ids.length - failed} sent, ${failed} could not be reached.`,
            });
          } else {
            toast.success(ids.length > 1 ? `Link sent to ${ids.length} members` : "Link sent");
          }
        })
      : onAdd(ids).then(() => {
          toast.success(ids.length > 1 ? `Added ${ids.length} people` : "Added to the call");
        });
    deliver
      .then(() => {
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

  const close = () => {
    if (!busy) {
      setPickerOpen(false);
      onClose();
    }
  };

  return (
    <>
      <Modal open={open && !pickerOpen} onClose={busy ? () => {} : onClose} title="Share meeting link">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Invite teammates to join this meeting with a secure link.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={() => setPickerOpen(true)} disabled={busy}>Send link</Button>
          </div>
        </div>
      </Modal>
      <Modal open={open && pickerOpen} onClose={busy ? () => {} : close} title="Send meeting link">
        <MemberPicker
          exclude={exclude}
          busy={busy}
          onConfirm={sendLink}
          onOrganization={canSendOrganization ? sendLink : undefined}
          confirmLabel="Send link"
          onCancel={close}
        />
      </Modal>
    </>
  );
}
