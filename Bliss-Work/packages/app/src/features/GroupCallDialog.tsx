import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { MAX_ADHOC_CALL_PARTICIPANTS } from "@taskboard/shared";
import { Modal } from "./Modal";
import { MemberPicker } from "./MemberPicker";
import { useRuntime } from "../lib/runtime";
import { useMeetingSession } from "../lib/MeetingSession";

/** Two people, because one is just a 1:1 call and rings from the chat. */
const MIN_PEOPLE = 2;
/** Nobody is excluded: the picker already leaves the caller out. */
const NO_ONE = new Set<string>();
/** Everyone besides the caller. */
const MAX_PEOPLE = MAX_ADHOC_CALL_PARTICIPANTS - 1;

/**
 * "Select B + C + D → Call": ONE ad-hoc call to several people at once.
 *
 * Not a meeting and not a call per person: the server makes a single DIRECT call
 * with no schedule — the same call a 1:1 becomes when somebody is added to it —
 * and rings everyone picked. The caller goes straight into its room; the others
 * get the incoming-call notice. Who may be called (same org, no blocks, the
 * participant limit) is the server's decision, and its refusal is shown as is.
 */
export function GroupCallDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounted only while open: the call state it reads is not needed (or even
  // provided, in a list rendered on its own) until somebody asks to make a call.
  return open ? <GroupCallPicker onClose={onClose} /> : null;
}

function GroupCallPicker({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("callRoom");
  const { api } = useRuntime();
  const session = useMeetingSession();
  const [busy, setBusy] = useState(false);

  const start = (userIds: string[]) => {
    // One call at a time: a second would leave the first running unattended.
    // `session.call` is the one "is a call already active" signal now that
    // every call (1:1 or group) goes through MeetingSession's room — see
    // DMView's own startCall for the 1:1 half of this.
    if (session.call) {
      toast.error(t("groupCall.alreadyInCall"));
      return;
    }
    setBusy(true);
    api
      .startConferenceCall(userIds, "video")
      .then((call) => {
        onClose();
        session.enter(call, undefined, "video");
      })
      .catch((e: unknown) =>
        toast.error(t("groupCall.failed"), {
          description: e instanceof Error && e.message ? e.message : undefined,
        }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={t("groupCall.title")}>
      <p className="mb-3 text-sm text-muted">{t("groupCall.description")}</p>
      <MemberPicker
        exclude={NO_ONE}
        busy={busy}
        onConfirm={start}
        confirmLabel={t("groupCall.callButton")}
        onCancel={onClose}
        minSelected={MIN_PEOPLE}
        maxSelected={MAX_PEOPLE}
        hint={(n) =>
          n > MAX_PEOPLE
            ? t("groupCall.limit", { max: MAX_ADHOC_CALL_PARTICIPANTS })
            : n < MIN_PEOPLE
              ? t("groupCall.pickTwo")
              : null
        }
      />
    </Modal>
  );
}
