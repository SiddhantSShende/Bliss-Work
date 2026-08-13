import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UserDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { qk } from "./queryBridge";

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
 */
export function useUserLabels() {
  const { api } = useRuntime();
  const { data: directory = [] } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
  });

  const byId = useMemo(
    () => new Map(directory.map((u: UserDTO) => [u.id, u])),
    [directory],
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
