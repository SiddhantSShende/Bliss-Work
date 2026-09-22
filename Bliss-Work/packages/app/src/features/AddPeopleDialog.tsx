import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@taskboard/ui";
import { Modal } from "./Modal";
import { MemberPicker } from "./MemberPicker";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { meetingJoinUrl } from "../lib/meetingDeepLink";

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
  const { t } = useTranslation("callRoom");
  const { api, config } = useRuntime();
  const me = useSession((s) => s.user);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const canSendOrganization = me?.roles.some((role) => role === "org_admin") ?? false;

  const sendLink = (ids: string[]) => {
    setBusy(true);
    const deliver = callId
      ? api.createCallInvite(callId).then(async ({ token }) => {
          const link = meetingJoinUrl(config.webBaseUrl, token);
          await onAdd(ids);
          const results = await Promise.allSettled(
            ids.map((id) => api.sendMessage(id, `Join the meeting: ${link}`)),
          );
          const failed = results.filter((result) => result.status === "rejected").length;
          if (failed > 0) {
            toast.warning(t("addPeopleDialog.linkSentWithExceptions"), {
              description: t("addPeopleDialog.linkSentWithExceptionsDescription", {
                sent: ids.length - failed,
                failed,
              }),
            });
          } else {
            toast.success(
              ids.length > 1
                ? t("addPeopleDialog.linkSentToMembers", { count: ids.length })
                : t("addPeopleDialog.linkSent"),
            );
          }
        })
      : onAdd(ids).then(() => {
          toast.success(
            ids.length > 1
              ? t("addPeopleDialog.addedPeople", { count: ids.length })
              : t("addPeopleDialog.addedToCall"),
          );
        });
    deliver
      .then(() => {
        onClose();
      })
      .catch((e: unknown) =>
        toast.error(t("addPeopleDialog.couldNotAdd"), {
          description:
            e instanceof Error && e.message ? e.message : t("addPeopleDialog.groupCallingUnavailable"),
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
      <Modal open={open && !pickerOpen} onClose={busy ? () => {} : onClose} title={t("addPeopleDialog.shareTitle")}>
        <div className="space-y-4">
          <p className="text-sm text-muted">{t("addPeopleDialog.shareDescription")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t("addPeopleDialog.cancel")}</Button>
            <Button size="sm" onClick={() => setPickerOpen(true)} disabled={busy}>{t("addPeopleDialog.sendLink")}</Button>
          </div>
        </div>
      </Modal>
      <Modal open={open && pickerOpen} onClose={busy ? () => {} : close} title={t("addPeopleDialog.sendTitle")}>
        <MemberPicker
          exclude={exclude}
          busy={busy}
          onConfirm={sendLink}
          onOrganization={canSendOrganization ? sendLink : undefined}
          confirmLabel={t("addPeopleDialog.sendLink")}
          onCancel={close}
        />
      </Modal>
    </>
  );
}
