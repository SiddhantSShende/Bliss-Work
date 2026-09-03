import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRuntime } from "./runtime";
import { meetingJoinUrl } from "./meetingDeepLink";

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
  const { api, config } = useRuntime();
  const [link, setLink] = useState<string | null>(null);

  const mint = useMutation({
    mutationFn: async () => {
      const invite = await api.createCallInvite(callId);
      return meetingJoinUrl(config.webBaseUrl, invite.token);
    },
    onError: () => toast.error("Couldn't create an invite link"),
  });

  const copyLink = async (): Promise<boolean> => {
    const url = link ?? (await mint.mutateAsync().catch(() => null));
    if (!url) return false;
    setLink(url);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      // Insecure origins and older WebViews have no clipboard API. The link is
      // on screen by now, so there is something to select rather than nothing.
      toast("Copy failed", { description: "Select the link and copy it manually." });
      return false;
    }
  };

  return { link, isPending: mint.isPending, copyLink };
}
