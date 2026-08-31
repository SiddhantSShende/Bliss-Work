/**
 * Per-request DataLoaders. This file is the reason the gateway is worth
 * building, and the reason it could make things worse if it is wrong.
 *
 * ── Why per-request, always ─────────────────────────────────────────────────
 * `createLoaders()` is called once per HTTP request and its result is never
 * cached, shared or hoisted to module scope. DataLoader's cache is keyed by id
 * alone — it knows nothing about tenants — so a loader that outlived a request
 * would serve one organisation's user records to the next caller. Every service
 * behind this gateway is protected by per-org row-level security; a module-scope
 * loader would route straight around it.
 *
 * ── Why batching is not optional ────────────────────────────────────────────
 * GraphQL runs a resolver per field, so `inboxPeers { user { email } }` asks for
 * a user once per row. Resolved naively that is one HTTP call per row: the
 * browser's N+1 moved server-side and made worse, since it now also crosses a
 * service boundary. The loader collapses every id referenced anywhere in one
 * operation into a single upstream call.
 */
import DataLoader from "dataloader";
import { UserDTO } from "@taskboard/shared";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import type { CallerContext, Upstream } from "./upstream.js";
import type { Metrics } from "./metrics.js";

/**
 * Ids per upstream request. MUST NOT exceed `MAX_BATCH_IDS` in
 * `services/auth-svc/app/routes/directory_service.py`, which rejects a larger
 * batch outright — so a page rendering more than this many distinct people
 * becomes two upstream calls rather than one failed query.
 */
export const USER_BATCH_SIZE = 200;

/**
 * Ceiling for `Query.users(ids)` ITSELF — distinct from `USER_BATCH_SIZE`,
 * which only bounds each individual upstream call once a request is already
 * underway and chunking. Without a ceiling on the resolver's own input, a
 * caller can put an arbitrarily large `ids` array in a registered
 * operation's VARIABLES: the persisted-operation allow-list (persisted.ts)
 * only constrains the query DOCUMENT, never the values a caller sends for
 * it, and depthLimit.ts only counts field nesting, not array-argument size.
 * A 50,000-id array would fan this resolver out into 250 sequential upstream
 * calls in one request — a trivial DoS from any authenticated caller.
 */
export const MAX_USERS_QUERY_IDS = 500;

const UserList = z.array(UserDTO);

export interface Loaders {
  /** Resolves to `null` for an id that is not in the caller's org, or belongs
   *  to nobody. Absence is never an error: the ids come from message and task
   *  rows, which outlive the accounts they reference. */
  readonly usersById: DataLoader<string, UserDTO | null>;
}

export function createLoaders(
  cfg: GatewayConfig,
  upstream: Upstream,
  caller: CallerContext,
  metrics?: Metrics,
): Loaders {
  const usersById = new DataLoader<string, UserDTO | null>(
    async (ids) => {
      // The series that proves batching still works. If this settles at 1 while
      // pages grow, the gateway has quietly become an N+1 generator and the
      // whole justification for it is gone.
      metrics?.loaderBatch.observe({ loader: "usersById" }, ids.length);
      const byId = new Map<string, UserDTO>();
      for (const chunk of chunkIds(ids, USER_BATCH_SIZE)) {
        const raw = await upstream.get<unknown>(
          "auth-svc",
          cfg.authBase,
          `/auth/users?ids=${chunk.map(encodeURIComponent).join(",")}`,
          caller,
        );
        // Validate at the boundary: this is another service's response, and the
        // resolvers below type it as a UserDTO on the strength of this parse.
        for (const user of UserList.parse(raw)) byId.set(user.id, user);
      }
      // DataLoader's contract: one entry per key, in key order. The upstream
      // sorts by username and omits ids it cannot resolve, so mapping by
      // position instead of by id would attach the wrong name to a row — a bug
      // that shows up as one colleague's e-mail address under another's name.
      return ids.map((id) => byId.get(id) ?? null);
    },
    {
      // Ids arrive as UUID strings, so the default identity cache key is right.
      // maxBatchSize is enforced by chunkIds instead, because a single logical
      // batch that spans two upstream calls still deduplicates across both.
      name: "usersById",
    },
  );

  return { usersById };
}

export function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size) as string[]);
  return out;
}
