import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useRuntime } from "./runtime";
import { qk } from "./queryBridge";

/** Join an open channel — the same mutation offered from ChannelsList's
 *  Browse tab and the AddChannelDialog popup's Add-Channel tab. */
export function useJoinChannel() {
  const { t } = useTranslation("chatList");
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.joinChannel(channelId),
    onSuccess: () => {
      toast.success(t("joinChannel.joined"));
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: qk.openChannels });
    },
    onError: (e) => toast.error(t("joinChannel.couldNotJoin"), { description: String(e) }),
  });
}
