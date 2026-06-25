import { Mail, Trash2 } from "lucide-react";
import { Badge, Button, EmptyState } from "@taskboard/ui";
import type { InviteDTO } from "@taskboard/shared";
import { relTime } from "./ListPane";

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
  if (invites.length === 0)
    return <EmptyState icon={<Mail size={22} />} title="No pending invites" hint="Invites you send will appear here." />;

  return (
    <div className="space-y-2">
      {invites.map((inv) => (
        <div key={inv.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 p-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Mail size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-fg">{inv.email}</div>
            <div className="text-xs text-muted">Expires {relTime(inv.expiresAt)}</div>
          </div>
          <Badge tone={inv.role === "org_admin" ? "accent" : "neutral"}>
            {inv.role === "org_admin" ? "Admin" : "Member"}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(inv.id)}
            loading={revokingId === inv.id}
            title="Revoke invite"
          >
            <Trash2 size={15} />
          </Button>
        </div>
      ))}
    </div>
  );
}
