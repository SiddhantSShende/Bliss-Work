import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { InboxPeerDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { qk } from "./queryBridge";
import { INBOX_KINDS } from "./inboxKinds";

/**
 * The People sidebar's data, from either transport.
 *
 * ── Why one hook and not three useQuery calls ────────────────────────────────
 * Three surfaces read `qk.inboxPeers`: the mail list, the folder/People
 * sidebar and the left-rail badge. They already share the kinds constant so
 * they cannot
 * disagree about what they are counting (see `inboxKinds.ts`); they must share
 * the FETCHER for the same reason. Two of them fetching this key by different
 * routes would put two shapes into one cache entry, and whichever rendered last
 * would win.
 *
 * ── What the GraphQL path adds ───────────────────────────────────────────────
 * `user`, resolved by the gateway in a single batched call for the whole list.
 * messaging-svc projects `username` and `displayName` onto each row but has
 * never carried an e-mail address, and `username` is derived from the e-mail
 * local part at signup — so a row rendered from the projection alone shows an
 * address fragment where a name belongs, and cannot show an address at all.
 * Before the gateway the only way to get either was to download the entire org
 * directory and join it in the browser.
 */
const ResolvedUser = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
});

export const InboxPeerView = InboxPeerDTO.extend({
  /** Absent on the REST path; null when the account no longer resolves. Either
   *  way the caller falls back to the projected fields, which is why a departed
   *  colleague still renders. */
  user: ResolvedUser.nullish(),
});
export type InboxPeerView = z.infer<typeof InboxPeerView>;

const InboxOverviewData = z.object({ inboxPeers: z.array(InboxPeerView) });

/**
 * How to render a peer, given whichever transport supplied it.
 *
 * Pure and exported so the precedence between the authoritative account and the
 * projected row is tested directly, rather than inferred from a rendered list.
 * The resolved account wins because the projection can lag a rename; the
 * projection is the fallback because the account may be gone.
 */
export function peerLabel(peer: InboxPeerView): { name: string; email: string | null } {
  return {
    name:
      peer.user?.displayName || peer.displayName || peer.username || "Unknown user",
    email: peer.user?.email || null,
  };
}

export function useInboxPeers(opts: { enabled?: boolean } = {}) {
  const { api, config } = useRuntime();
  // The gateway fronts this screen only where it is configured. No gateway ⇒
  // the REST path, unchanged — which is what makes the rollout a config change
  // rather than a deploy.
  const viaGraph = Boolean(config.graphBase);

  return useQuery<InboxPeerView[]>({
    queryKey: qk.inboxPeers,
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      if (!viaGraph) return api.inboxPeers(INBOX_KINDS);
      const data = await api.graphql(
        "InboxOverview",
        { kinds: INBOX_KINDS },
        InboxOverviewData,
      );
      return data.inboxPeers;
    },
  });
}
