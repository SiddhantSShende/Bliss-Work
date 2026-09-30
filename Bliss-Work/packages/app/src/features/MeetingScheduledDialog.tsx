import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Link2, Video } from "lucide-react";
import type { CallDTO } from "@taskboard/shared";
import { useCallInviteLink } from "../lib/useCallInviteLink";
import { MeetingDialogShell } from "./MeetingDialogShell";
import { MeetingPreview } from "./MeetingPreview";

/**
 * "Meeting Scheduled!" — what NewMeetingDialog shows in place of the form
 * once `create` has actually succeeded. The meeting details are the same
 * MeetingPreview the form itself showed a moment ago, now describing what
 * was actually created rather than what was about to be.
 *
 * The join link is real — minted through the same useCallInviteLink the
 * in-room invite control uses (createCallInvite), not assembled locally. It
 * mints itself on mount so the link is already on screen rather than waiting
 * for a Copy click, same reasoning MeetingInviteLink's own gate gives for
 * only ever showing a link that exists.
 *
 * `onStarted` and `onViewInCalendar` are both optional and both close the
 * dialog themselves after firing, independent of whatever the caller's own
 * handler does — this component owns its own closing, the way the rest of
 * NewMeetingDialog's footer already does.
 */
export function MeetingScheduledDialog({
  call,
  title,
  startAt,
  endAt,
  inviteeNames,
  channelNames,
  onClose,
  onStarted,
  onViewInCalendar,
}: {
  call: CallDTO;
  title: string;
  startAt: Date;
  endAt: Date;
  inviteeNames: string[];
  channelNames: string[];
  onClose: () => void;
  onStarted?: (call: CallDTO) => void;
  onViewInCalendar?: (call: CallDTO) => void;
}) {
  const { t } = useTranslation("meetings");
  const { link, isPending, copyLink, ensureLink } = useCallInviteLink(call.id);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void ensureLink();
    // Mint once for THIS call, on mount. Deliberately keyed on call.id alone:
    // ensureLink is a fresh closure every render (it's not memoized), and
    // depending on it here would re-run the mint on every render up to the
    // moment `link` settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.id]);

  const onCopy = async () => {
    if (!(await copyLink())) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <MeetingDialogShell
      title={t("newMeeting.confirmation.title")}
      closeLabel={t("newMeeting.confirmation.dismiss")}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            {t("newMeeting.confirmation.close")}
          </button>
          <button
            type="button"
            onClick={() => {
              onViewInCalendar?.(call);
              onClose();
            }}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            {t("newMeeting.confirmation.viewInCalendar")}
          </button>
          <button
            type="button"
            onClick={() => {
              onStarted?.(call);
              onClose();
            }}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:brightness-105"
          >
            <Video size={15} />
            {t("newMeeting.confirmation.startNow")}
          </button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-1.5 pb-1 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-success/10 text-success">
          <Check size={22} />
        </span>
        <p className="text-sm text-gray-500">{t("newMeeting.confirmation.subtitle")}</p>
      </div>

      <MeetingPreview
        title={title}
        startAt={startAt}
        endAt={endAt}
        inviteeNames={inviteeNames}
        channelNames={channelNames}
      />

      <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
        <Link2 size={14} className="shrink-0 text-gray-400" aria-hidden />
        {link ? (
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-gray-900">{link}</code>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-gray-500">
            {isPending ? t("newMeeting.confirmation.generatingLink") : ""}
          </span>
        )}
        <button
          type="button"
          onClick={() => void onCopy()}
          disabled={isPending}
          className="flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          {copied ? t("newMeeting.confirmation.linkCopied") : t("newMeeting.confirmation.copyLink")}
        </button>
      </div>
    </MeetingDialogShell>
  );
}
