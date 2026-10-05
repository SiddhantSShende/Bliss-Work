import { Mail, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Button, EmptyState } from "@taskboard/ui";
import type { InviteDTO } from "@taskboard/shared";
import { relTime } from "./ListPane";
import { RoleBadge } from "./RoleBadge";

/** Pending-invite rows with a revoke action (admin invite page). */
export function InviteList({
  invites,
  onRevoke,
  revokingId,
}: {
  invites: InviteDTO[];
  onRevoke: (id: string) => void;
  revokingId?: string;
}) {
  const { t } = useTranslation("auth");

  if (invites.length === 0)
    return (
      <EmptyState
        icon={<Mail size={22} />}
        title={t("inviteList.emptyTitle")}
        hint={t("inviteList.emptyHint")}
      />
    );

  const now = Date.now();

  return (
    <div className="space-y-2">
      {invites.map((inv) => {
        // An invite past its expiry keeps status='pending' in the DB (nothing
        // flips it), so derive "expired" from the timestamp for display. The
        // server already rejects expired tokens at verify/accept time — this is
        // purely so the admin list shows the real state instead of a stale
        // "Expires <past date>".
        const expired = new Date(inv.expiresAt).getTime() <= now;
        return (
          <div key={inv.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 p-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Mail size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-fg">{inv.email}</div>
              <div className={`text-xs ${expired ? "text-danger" : "text-muted"}`}>
                {expired ? t("inviteList.expired") : t("inviteList.expires")} {relTime(inv.expiresAt)}
              </div>
            </div>
            {expired && <Badge tone="danger">{t("inviteList.expired")}</Badge>}
            <RoleBadge isAdmin={inv.role === "org_admin"} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRevoke(inv.id)}
              loading={revokingId === inv.id}
              title={expired ? t("inviteList.removeExpired") : t("inviteList.revoke")}
            >
              <Trash2 size={15} />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
