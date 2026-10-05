import { Laptop } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button } from "@taskboard/ui";
import type { ActiveSessionDTO } from "@taskboard/shared";
import { relativeTime } from "../lib/relativeTime";

/**
 * One row per active session (refresh-token family) — shared by the
 * self-service "Active sessions" settings page (routes/ActiveSessions.tsx)
 * and the admin session panel on a member's detail page (MemberAdmin.tsx),
 * so the two render sessions identically. Purely presentational: data
 * fetching, revoke mutations and confirmation live in each caller, because
 * the two have different authorization (self vs. org_admin), different
 * revoke endpoints, and the self-service one additionally has to route a
 * revoke of ITS OWN current session through the shared sign-out flow rather
 * than a bare DELETE — see ActiveSessions.tsx's onRevoke for why.
 */
export function ActiveSessionsList({
  sessions,
  onRevoke,
  revokingId,
  currentSessionId = null,
}: {
  sessions: ActiveSessionDTO[];
  onRevoke: (session: ActiveSessionDTO) => void;
  /** The id currently being revoked, so only that row shows a spinner —
   *  revoking one session must not visually block the others. */
  revokingId: string | null;
  /** This viewer's OWN session id, decoded client-side from the access
   *  token's `sid` claim (ActiveSessionDTO carries no such field — see its
   *  doc comment). Always null on the admin panel, which never shows the
   *  admin's own session. */
  currentSessionId?: string | null;
}) {
  const { t } = useTranslation("account");
  return (
    <div className="space-y-1">
      {sessions.map((s) => {
        const isCurrent = s.id === currentSessionId;
        return (
          <div key={s.id} className="flex items-start gap-3 rounded-xl p-2.5 hover:bg-surface-2">
            <Laptop size={16} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg">{s.device}</span>
                {isCurrent && <Badge tone="success">{t("account:activeSessionsList.thisDevice")}</Badge>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                <span title={s.lastSeenAt}>
                  {t("account:activeSessionsList.active", { time: relativeTime(s.lastSeenAt) })}
                </span>
                <span title={s.createdAt}>
                  {t("account:activeSessionsList.signedIn", { time: relativeTime(s.createdAt) })}
                </span>
                {/* A /24 or /48 prefix, never the full address — see
                    ActiveSessionDTO's doc comment in packages/shared. */}
                {s.approxLocation && (
                  <span title={t("account:activeSessionsList.approximateNetwork")}>{s.approxLocation}</span>
                )}
              </div>
            </div>
            <Button
              size="sm"
              variant={isCurrent ? "danger" : "secondary"}
              loading={revokingId === s.id}
              disabled={revokingId !== null && revokingId !== s.id}
              onClick={() => onRevoke(s)}
            >
              {t("account:activeSessionsList.signOut")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
