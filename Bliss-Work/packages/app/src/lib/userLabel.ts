import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { ApiClient } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { qk } from "./queryBridge";

/** Only the fields a label (or avatar) needs. The gateway is asked for exactly
 *  these, which is the whole point of asking it rather than the directory.
 *  `avatarUrl` is optional so a GraphQL gateway that predates it still
 *  validates — a caller then just gets no image, same as never uploading one. */
const LabelUser = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable().optional(),
});
type LabelUser = z.infer<typeof LabelUser>;
const UsersByIdsData = z.object({ users: z.array(LabelUser) });

/**
 * The scoped lookup as a TanStack Query descriptor, so the hook below and
 * imperative callers (`qc.fetchQuery`) share ONE definition of the operation,
 * its schema and its cache key. Two copies would be two places to forget that
 * unresolvable ids are omitted rather than nulled.
 */
export function usersByIdsQuery(api: ApiClient, ids: readonly string[]) {
  const key = [...new Set(ids.filter(Boolean))].sort();
  return {
    queryKey: qk.usersByIds(key),
    queryFn: () => api.graphql("UsersByIds", { ids: key }, UsersByIdsData).then((d) => d.users),
  };
}

/**
 * How to render a person, in the two ways the product needs them.
 *
 * ── The trap this exists to close ────────────────────────────────────────────
 * `username` is NOT a handle anyone chose. auth-svc derives it from the email
 * local-part at signup (`str(body.email).split("@", 1)[0]`), so a user who
 * signed up as jane.okafor@acme.com is projected into messaging as
 * "jane.okafor". Chat surfaces rendered that field directly, which is why the
 * app showed email fragments where names belong.
 *
 * ── Why the directory rather than the message payload ────────────────────────
 * messaging-svc projects `username` and `display_name`, but NOT the email
 * address — it has never needed one. The Inbox, which is styled after an email
 * client, does need it. `GET /auth/directory` already returns every active org
 * member with `displayName` and `email`, is already cached app-wide under
 * `qk.directory`, and is already fetched by several screens, so joining on the
 * user id here costs nothing extra.
 *
 * ── Fallbacks are deliberate, not defensive ──────────────────────────────────
 * The directory omits suspended and removed members, and the messaging
 * projection can lag a rename by a moment. Both helpers therefore take the
 * DTO's own value as a fallback, so a departed colleague's messages keep
 * rendering something rather than "Unknown user".
 *
 * ── Passing `ids` ────────────────────────────────────────────────────────────
 * A caller that already knows whose names it is about to draw — a meeting
 * roster has `call.participants` in hand — should say so. With a GraphQL
 * gateway configured, that turns a 5,000-row directory download into a lookup
 * for exactly those people. Without one, or without `ids`, the directory path
 * is unchanged, so this is safe to adopt one caller at a time.
 *
 * Callers that genuinely cannot know the set up front (a paginated feed whose
 * rows arrive over a socket) keep calling this with no argument.
 */
export function useUserLabels(ids?: readonly string[]) {
  const { api, config } = useRuntime();

  // Sorted + de-duplicated so a re-render that reorders the same people reuses
  // the cache entry instead of minting a new one.
  const wanted = useMemo(
    () => (ids ? [...new Set(ids.filter(Boolean))].sort() : []),
    [ids],
  );
  const scoped = Boolean(config.graphBase) && ids !== undefined;

  const { data: directory = [] } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
    // Skipped entirely on the scoped path — fetching the whole org and then not
    // reading it would defeat the exercise.
    enabled: !scoped,
  });

  const { data: resolved = [] } = useQuery({
    ...usersByIdsQuery(api, wanted),
    enabled: scoped && wanted.length > 0,
  });

  const byId = useMemo(
    () => new Map<string, LabelUser>((scoped ? resolved : directory).map((u) => [u.id, u])),
    [scoped, resolved, directory],
  );

  return useMemo(
    () => ({
      /** Human name for a user id. `fallback` is typically the DTO's own
       *  `peerDisplayName ?? peerUsername`. */
      nameOf: (userId: string | null | undefined, fallback?: string | null) =>
        (userId ? byId.get(userId)?.displayName : undefined) || fallback || "Unknown user",
      /** Email address for a user id — the Inbox's primary identifier. */
      emailOf: (userId: string | null | undefined, fallback?: string | null) =>
        (userId ? byId.get(userId)?.email : undefined) || fallback || "—",
      /** Profile picture for a user id, resolved live rather than trusting a
       *  DTO-embedded copy — the same staleness this hook already closes for
       *  names (see the module docstring). No fallback: an unresolved id just
       *  renders initials, same as a user who never set a photo. */
      avatarUrlOf: (userId: string | null | undefined): string | null | undefined =>
        userId ? byId.get(userId)?.avatarUrl : undefined,
    }),
    [byId],
  );
}

/**
 * Name for a chat DTO that already carries both projected fields, with no
 * directory lookup. Use this in render paths that have the DTO in hand — it is
 * synchronous and cannot go stale against a query cache.
 */
export function displayNameOf(
  dto: { peerDisplayName?: string; peerUsername?: string } | null | undefined,
): string {
  return dto?.peerDisplayName || dto?.peerUsername || "Unknown user";
}
