import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangle, ScrollText } from "lucide-react";
import { Avatar, Button, EmptyState, Spinner } from "@taskboard/ui";
import type { MemberDTO } from "@taskboard/shared";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";

/**
 * The org's audit trail, optionally scoped to one member.
 *
 * auth-svc has hash-chained every entry since migration 0004 and shipped a
 * verifier — but never a way to READ it, so three years of `invite.revoked` and
 * `password.reset_completed` rows were only ever visible from psql. This is that
 * read path.
 */
const LABELS: Record<string, string> = {
  "org.created": "created the workspace",
  "user.profile_updated": "updated their profile",
  "invite.created": "invited someone",
  "invite.accepted": "accepted an invite",
  "invite.revoked": "revoked an invite",
  "password.reset_requested": "requested a password reset",
  "password.reset_completed": "completed a password reset",
  "email.verified": "verified their email",
  "member.role_changed": "changed a role",
  "member.deactivated": "suspended a member",
  "member.reactivated": "reactivated a member",
  "member.removed": "removed a member",
};

/** `members` must be the FULL roster (including suspended/removed people),
 *  not the active-only directory — an actor or target who has since been
 *  suspended or removed must still resolve to their real name here rather
 *  than falling back to "System". */
export function MemberAuditLog({ targetId, members }: { targetId?: string; members: MemberDTO[] }) {
  const { api } = useRuntime();
  const byId = new Map(members.map((m) => [m.id, m]));

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: qk.audit(targetId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.auditLog({ before: pageParam, targetId, limit: 30 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const entries = data?.pages.flatMap((p) => p.entries) ?? [];

  if (isLoading) return <div className="flex justify-center p-8"><Spinner /></div>;
  // Distinct from the "nothing recorded yet" empty state below — a failed
  // fetch must not look like a genuinely empty audit trail (see the domain.ts
  // AuditPage id/nextCursor type fix this pairs with).
  if (isError)
    return (
      <EmptyState
        icon={<AlertTriangle size={22} />}
        title="Audit log could not be loaded"
        hint="Check your connection and try again."
      />
    );
  if (entries.length === 0)
    return (
      <EmptyState
        icon={<ScrollText size={22} />}
        title="Nothing recorded yet"
        hint={targetId ? "Admin actions on this member will show up here." : "Admin actions across the workspace show up here."}
      />
    );

  return (
    <div className="space-y-1">
      {entries.map((e) => {
        const actor = e.actorId ? byId.get(e.actorId) : undefined;
        const target = e.target ? byId.get(e.target) : undefined;
        return (
          <div key={e.id} className="flex items-start gap-3 rounded-xl p-2.5 hover:bg-surface-2">
            <Avatar name={actor?.displayName ?? "System"} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg">
                <span className="font-medium">{actor?.displayName ?? "System"}</span>{" "}
                {LABELS[e.action] ?? e.action}
                {target && !targetId && <span className="font-medium"> · {target.displayName}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{new Date(e.at).toLocaleString()}</span>
                {renderMeta(e.meta)}
              </div>
            </div>
          </div>
        );
      })}
      {hasNextPage && (
        <div className="pt-2 text-center">
          <Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}

/** `meta` is free-form jsonb; render the from→to pair the member actions write
 *  and fall back to nothing rather than dumping raw JSON at the user. */
function renderMeta(meta: Record<string, unknown> | null) {
  if (!meta) return null;
  const from = meta.from;
  const to = meta.to;
  if (to == null) return null;
  const fmt = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5">
      {from != null ? `${fmt(from)} → ${fmt(to)}` : fmt(to)}
    </span>
  );
}
