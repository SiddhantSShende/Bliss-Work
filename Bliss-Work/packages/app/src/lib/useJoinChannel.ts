import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRuntime } from "./runtime";
import { qk } from "./queryBridge";

/** Join an open channel — the same mutation offered from ChannelsList's
 *  Browse tab and the AddChannelDialog popup's Add-Channel tab. */
export function useJoinChannel() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) => api.joinChannel(channelId),
    onSuccess: () => {
      toast.success("Joined the channel.");
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: qk.openChannels });
    },
    onError: (e) => toast.error("Couldn't join", { description: String(e) }),
  });
}
