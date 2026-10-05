import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useRuntime } from "./runtime";
import { meetingJoinUrl } from "./meetingDeepLink";
import { copyText } from "./clipboard";

/**
 * Mint (once) and copy a link anyone can use to join a call.
 *
 * Shared by MeetingInviteLink (outside the room) and CallRoom (inside it) —
 * same `createCallInvite` call, same local cache so copying twice does not
 * mint (and spend) a second token: the join route's token is only ever valid
 * coming back once. What differs between the two callers is what happens
 * AFTER a successful copy (an inline checkmark vs. a toast), which is left to
 * each of them — `copyLink` reports success/failure and nothing more.
 */
export function useCallInviteLink(callId: string) {
  const { t } = useTranslation("meetings");
  const { api, config } = useRuntime();
  const [link, setLink] = useState<string | null>(null);

  const mint = useMutation({
    mutationFn: async () => {
      const invite = await api.createCallInvite(callId);
      return meetingJoinUrl(config.webBaseUrl, invite.token);
    },
    onError: () => toast.error(t("inviteLink.couldNotCreate")),
  });

  /** Mint the link if there isn't one yet, without copying it anywhere —
   *  what a caller that wants the real link ON SCREEN before any copy click
   *  (MeetingScheduledDialog) calls directly. copyLink below is just this
   *  plus the clipboard write. */
  const ensureLink = async (): Promise<string | null> => {
    if (link) return link;
    const url = await mint.mutateAsync().catch(() => null);
    if (url) setLink(url);
    return url;
  };

  const copyLink = async (): Promise<boolean> => {
    const url = await ensureLink();
    if (!url) return false;
    if (await copyText(url)) return true;
    // The link is on screen by now, so there is something to select rather
    // than nothing.
    toast(t("inviteLink.copyFailed"), { description: t("inviteLink.copyManually") });
    return false;
  };

  return { link, isPending: mint.isPending, copyLink, ensureLink };
}
