/**
 * Resolvers. Each one either delegates to a DataLoader (for anything that can
 * be asked for more than once in a single operation) or makes exactly one
 * upstream call for the whole field.
 *
 * No resolver may make a call per item. That rule is what separates this
 * gateway from an N+1 generator, and `test/schema.test.ts` asserts it by
 * counting upstream calls rather than by inspecting the code.
 */
import { InboxItemKind, InboxPeerDTO, UserDTO } from "@taskboard/shared";
import { z } from "zod";
import type { GraphContext } from "./context.js";

const InboxPeerList = z.array(InboxPeerDTO);

/** The wire shape of an inbox peer, plus the id its `user` field resolves. */
type PeerSource = z.infer<typeof InboxPeerDTO>;

export const resolvers = {
  Query: {
    async me(_root: unknown, _args: unknown, ctx: GraphContext) {
      const raw = await ctx.upstream.get<unknown>(
        "auth-svc",
        ctx.cfg.authBase,
        "/auth/me",
        ctx.caller,
      );
      return UserDTO.parse(raw);
    },

    async users(_root: unknown, args: { ids: string[] }, ctx: GraphContext) {
      // loadMany resolves through the same per-request batch as every other
      // user reference in this operation, so asking for people the page already
      // referenced costs nothing extra.
      const found = await ctx.loaders.usersById.loadMany(args.ids);
      return found.filter((u): u is z.infer<typeof UserDTO> => u !== null && !(u instanceof Error));
    },

    async inboxPeers(
      _root: unknown,
      args: { kinds?: string[] | null },
      ctx: GraphContext,
    ): Promise<PeerSource[]> {
      // The enum is validated by GraphQL before we get here, so these values are
      // already constrained to the three the upstream accepts.
      const kinds = (args.kinds ?? []).filter((k) => InboxItemKind.safeParse(k).success);
      const qs = kinds.length > 0 ? `?kinds=${kinds.join(",")}` : "";
      const raw = await ctx.upstream.get<unknown>(
        "messaging-svc",
        ctx.cfg.messagingBase,
        `/api/v1/inbox/peers${qs}`,
        ctx.caller,
      );
      return InboxPeerList.parse(raw);
    },
  },

  InboxPeer: {
    /**
     * The field the whole pilot exists for. Called once per row; the loader
     * collapses every one of those into a single `/auth/users?ids=` call —
     * replacing a fetch of the entire organisation directory that the browser
     * previously did to answer exactly this question.
     */
    user(peer: PeerSource, _args: unknown, ctx: GraphContext) {
      return ctx.loaders.usersById.load(peer.peerId);
    },
  },
};
