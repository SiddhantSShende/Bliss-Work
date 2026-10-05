import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ShieldCheck, ShieldOff, UserMinus, UserPlus } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Badge, Button, EmptyState, Spinner } from "@taskboard/ui";
import { ApiError, type ActiveSessionDTO, type MemberDTO, type Role } from "@taskboard/shared";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { ConfirmDialog } from "../ConfirmDialog";
import { RoleBadge } from "../RoleBadge";
import { ActiveSessionsList } from "../ActiveSessionsList";

/**
 * Admin actions on one member: role, suspend, remove.
 *
 * Every mutation returns the updated MemberDTO, so the roster is refreshed from
 * the server rather than patched optimistically. These are rare, deliberate,
 * consequential actions — a wrong optimistic paint that later rolls back would
 * be worse than the few hundred milliseconds it costs to be sure. (Contrast
 * AvailablePeople, where hiding someone is frequent, cheap and reversible.)
 */
export function MemberAdmin({
  member,
  isSelf,
  onChanged,
}: {
  member: MemberDTO;
  isSelf: boolean;
  onChanged: (m: MemberDTO) => void;
}) {
  const { t } = useTranslation("members");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"suspend" | "remove" | null>(null);

  const settled = (m: MemberDTO) => {
    onChanged(m);
    qc.invalidateQueries({ queryKey: qk.members });
    qc.invalidateQueries({ queryKey: qk.directory });
    qc.invalidateQueries({ queryKey: qk.audit(member.id) });
  };
  const failed = (e: unknown) => toast.error(e instanceof Error ? e.message : t("members:admin.toasts.actionFailed"));

  const role = useMutation({
    mutationFn: (r: Role) => api.changeMemberRole(member.id, r),
    onSuccess: (m) => {
      settled(m);
      toast.success(
        m.roles.includes("org_admin")
          ? t("members:admin.toasts.nowAdmin", { name: m.displayName })
          : t("members:admin.toasts.nowMember", { name: m.displayName }),
      );
    },
    onError: failed,
  });

  const lifecycle = useMutation({
    mutationFn: (action: "suspend" | "reactivate" | "remove") =>
      action === "suspend"
        ? api.deactivateMember(member.id)
        : action === "reactivate"
          ? api.reactivateMember(member.id)
          : api.removeMember(member.id),
    onSuccess: (m) => {
      settled(m);
      setConfirm(null);
      toast.success(
        m.status === "active"
          ? t("members:admin.toasts.reactivated", { name: m.displayName })
          : m.status === "suspended"
            ? t("members:admin.toasts.suspended", { name: m.displayName })
            : t("members:admin.toasts.removed", { name: m.displayName }),
      );
    },
    onError: (e) => {
      setConfirm(null);
      failed(e);
    },
  });

  if (isSelf) {
    return (
      <p className="rounded-xl bg-surface-2 p-4 text-sm text-muted">
        {t("members:admin.selfGuard")}
      </p>
    );
  }

  const isAdmin = member.roles.includes("org_admin");
  const busy = role.isPending || lifecycle.isPending;

  return (
    <div className="space-y-5">
      <Section
        title={t("members:admin.sections.role.title")}
        hint={t("members:admin.sections.role.hint")}
      >
        <div className="flex items-center gap-2">
          <RoleBadge isAdmin={isAdmin} />
          <Button
            size="sm"
            variant="secondary"
            loading={role.isPending}
            disabled={busy || member.status !== "active"}
            onClick={() => role.mutate(isAdmin ? "member" : "org_admin")}
          >
            {isAdmin ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
            {isAdmin ? t("members:admin.actions.demote") : t("members:admin.actions.makeAdmin")}
          </Button>
        </div>
        {member.status !== "active" && (
          <p className="text-xs text-muted">{t("members:admin.reactivateFirst")}</p>
        )}
      </Section>

      <Section
        title={t("members:admin.sections.access.title")}
        hint={t("members:admin.sections.access.hint")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={member.status === "active" ? "success" : member.status === "suspended" ? "warning" : "danger"}>
            {statusLabel(member.status, t)}
          </Badge>
          {member.status === "active" ? (
            <>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirm("suspend")}>
                <ShieldOff size={15} /> {t("members:admin.actions.suspend")}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("remove")}>
                <UserMinus size={15} /> {t("members:admin.actions.remove")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="success"
                loading={lifecycle.isPending}
                disabled={busy}
                onClick={() => lifecycle.mutate("reactivate")}
              >
                <UserPlus size={15} /> {t("members:admin.actions.reactivate")}
              </Button>
              {member.status === "suspended" && (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("remove")}>
                  <UserMinus size={15} /> {t("members:admin.actions.remove")}
                </Button>
              )}
            </>
          )}
        </div>
      </Section>

      <MemberSessionsSection memberId={member.id} />

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => !lifecycle.isPending && setConfirm(null)}
        title={confirm === "remove" ? t("members:admin.confirmDialog.removeTitle") : t("members:admin.confirmDialog.suspendTitle")}
        message={
          confirm === "remove" ? (
            <Trans
              i18nKey="members:admin.confirmDialog.removeMessage"
              values={{ name: member.displayName }}
              components={{ bold: <strong className="text-fg" /> }}
            />
          ) : (
            <Trans
              i18nKey="members:admin.confirmDialog.suspendMessage"
              values={{ name: member.displayName }}
              components={{ bold: <strong className="text-fg" /> }}
            />
          )
        }
        confirmLabel={confirm === "remove" ? t("members:admin.actions.remove") : t("members:admin.actions.suspend")}
        danger
        busy={lifecycle.isPending}
        onConfirm={() => lifecycle.mutate(confirm === "remove" ? "remove" : "suspend")}
      />
    </div>
  );
}

function statusLabel(status: MemberDTO["status"], t: TFunction): string {
  switch (status) {
    case "active":
      return t("members:status.active");
    case "suspended":
      return t("members:status.suspended");
    case "removed":
      return t("members:status.removed");
  }
}

/**
 * A member's active sign-in sessions, with per-session remote sign-out.
 *
 * Separate query/mutation from the self-service ActiveSessions.tsx page —
 * different endpoint (GET/DELETE /auth/members/{id}/sessions, org_admin
 * only). Passes no `currentSessionId` to ActiveSessionsList (defaults to
 * null): this is never the admin's own session — the server itself refuses
 * that with a 409, same self-action rule as suspend/remove above. Shares
 * ActiveSessionsList for the row rendering so a session looks the same
 * whether an admin or the member themselves is looking at it.
 */
function MemberSessionsSection({ memberId }: { memberId: string }) {
  const { t } = useTranslation("members");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [confirmSession, setConfirmSession] = useState<ActiveSessionDTO | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const { data: sessions, isLoading, isError } = useQuery({
    queryKey: qk.memberActiveSessions(memberId),
    queryFn: () => api.listMemberSessions(memberId),
  });

  const confirmRevoke = async () => {
    if (!confirmSession) return;
    const target = confirmSession;
    setRevokingId(target.id);
    try {
      await api.revokeMemberSession(memberId, target.id);
      qc.setQueryData<ActiveSessionDTO[]>(qk.memberActiveSessions(memberId), (prev) =>
        (prev ?? []).filter((s) => s.id !== target.id),
      );
      toast.success(t("members:admin.sessions.signedOutToast", { device: target.device }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        await qc.invalidateQueries({ queryKey: qk.memberActiveSessions(memberId) });
      } else {
        toast.error(t("members:admin.sessions.revokeFailedToast.title"), {
          description: t("members:admin.sessions.revokeFailedToast.description"),
        });
      }
    } finally {
      setRevokingId(null);
      setConfirmSession(null);
    }
  };

  return (
    <Section
      title={t("members:admin.sections.activeSessions.title")}
      hint={t("members:admin.sections.activeSessions.hint")}
    >
      {isLoading ? (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      ) : isError ? (
        <EmptyState
          icon={<AlertTriangle size={22} />}
          title={t("members:admin.sessions.loadError.title")}
          hint={t("members:admin.sessions.loadError.hint")}
        />
      ) : !sessions || sessions.length === 0 ? (
        <p className="text-sm text-muted">{t("members:admin.sessions.none")}</p>
      ) : (
        <ActiveSessionsList sessions={sessions} revokingId={revokingId} onRevoke={setConfirmSession} />
      )}

      <ConfirmDialog
        open={confirmSession !== null}
        onClose={() => !revokingId && setConfirmSession(null)}
        title={t("members:admin.sessions.confirmDialog.title")}
        message={
          <Trans
            i18nKey="members:admin.sessions.confirmDialog.message"
            values={{ device: confirmSession?.device }}
            components={{ bold: <strong className="text-fg" /> }}
          />
        }
        confirmLabel={t("members:admin.sessions.confirmDialog.confirmLabel")}
        danger
        busy={revokingId === confirmSession?.id}
        onConfirm={confirmRevoke}
      />
    </Section>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl border border-border/60 p-4">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children}
      <p className="text-xs leading-relaxed text-muted">{hint}</p>
    </section>
  );
}
