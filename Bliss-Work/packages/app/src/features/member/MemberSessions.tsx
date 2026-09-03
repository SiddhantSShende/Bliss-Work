import { useInfiniteQuery } from "@tanstack/react-query";
import { Laptop, MonitorSmartphone } from "lucide-react";
import { Badge, Button, EmptyState, Spinner } from "@taskboard/ui";
import type { ActivitySessionDTO } from "@taskboard/shared";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { formatDuration } from "./activityLabels";

/**
 * Sign-in sessions: device, when it started, when it ended and why.
 *
 * `endReason` is worth reading carefully — it is the difference between "they
 * signed out" and "we stopped hearing from them". Only two reasons are ever
 * actually written by telemetry-svc today:
 *   disconnect  the tab closed and got the goodbye out
 *   timeout     they went quiet; ended_at is the LAST time we heard from them,
 *               not the moment we noticed
 * Nothing currently closes a session for a suspend, removal, role change, or
 * org switch, so those reasons never appear here.
 */
const END_REASON: Record<string, string> = {
  disconnect: "Closed the app",
  timeout: "Went quiet",
};

export function MemberSessions({ userId }: { userId: string }) {
  const { api } = useRuntime();

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: qk.activitySessions(userId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.activitySessions(userId, { cursor: pageParam, limit: 25 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const sessions = data?.pages.flatMap((p) => p.sessions) ?? [];

  if (isLoading) return <div className="flex justify-center p-8"><Spinner /></div>;
  if (sessions.length === 0)
    return (
      <EmptyState
        icon={<MonitorSmartphone size={22} />}
        title="No sessions recorded"
        hint="Sessions appear here once they sign in from a device."
      />
    );

  return (
    <div className="space-y-1">
      {sessions.map((s) => <Row key={s.id} session={s} />)}
      {hasNextPage ? (
        <div className="pt-2 text-center">
          <Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
            Load older
          </Button>
        </div>
      ) : (
        // Same visibility window as the timeline — see the note there.
        <p className="pt-2 text-center text-xs text-muted">
          Showing the last 7 days. Older sessions are retained but not browsable here.
        </p>
      )}
    </div>
  );
}

function Row({ session: s }: { session: ActivitySessionDTO }) {
  const live = !s.endedAt;
  const start = new Date(s.startedAt);
  const end = s.endedAt ? new Date(s.endedAt) : null;
  const span = (end ?? new Date()).getTime() - start.getTime();

  return (
    <div className="flex items-start gap-3 rounded-xl p-2.5 hover:bg-surface-2">
      <Laptop size={16} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg">{s.deviceLabel}</span>
          {live ? (
            <Badge tone="success">Active now</Badge>
          ) : (
            <Badge tone="neutral">{END_REASON[s.endReason ?? ""] ?? s.endReason}</Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
          <span>
            {start.toLocaleString(undefined, {
              day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
            })}
            {end && ` – ${end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
          </span>
          {formatDuration(span) && <span>{formatDuration(span)} total</span>}
          {/* Active vs idle is the distinction that makes this useful: a tab
              left open all night is a long session and almost no active time. */}
          {formatDuration(s.activeMs) && <span>{formatDuration(s.activeMs)} active</span>}
          {formatDuration(s.idleMs) && <span>{formatDuration(s.idleMs)} idle</span>}
          {/* A /24, never the full address — enough to notice a sign-in from
              somewhere new without storing something identifying in the clear. */}
          {s.ipPrefix && <span title="Approximate network">{s.ipPrefix}</span>}
        </div>
      </div>
    </div>
  );
}
