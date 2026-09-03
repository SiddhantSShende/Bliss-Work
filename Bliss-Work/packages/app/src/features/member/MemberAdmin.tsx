import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldCheck, ShieldOff, UserMinus, UserPlus } from "lucide-react";
import { Badge, Button } from "@taskboard/ui";
import type { MemberDTO, Role } from "@taskboard/shared";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { ConfirmDialog } from "../ConfirmDialog";
import { RoleBadge } from "../RoleBadge";

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
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"suspend" | "remove" | null>(null);

  const settled = (m: MemberDTO) => {
    onChanged(m);
    qc.invalidateQueries({ queryKey: qk.members });
    qc.invalidateQueries({ queryKey: qk.directory });
    qc.invalidateQueries({ queryKey: qk.audit(member.id) });
  };
  const failed = (e: unknown) => toast.error(e instanceof Error ? e.message : "Action failed");

  const role = useMutation({
    mutationFn: (r: Role) => api.changeMemberRole(member.id, r),
    onSuccess: (m) => {
      settled(m);
      toast.success(`${m.displayName} is now ${m.roles.includes("org_admin") ? "an admin" : "a member"}`);
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
          ? `${m.displayName} can sign in again`
          : m.status === "suspended"
            ? `${m.displayName} is suspended`
            : `${m.displayName} was removed from the workspace`,
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
        You can't change your own role or membership. Ask another admin — that rule is
        what stops the last admin locking everyone, including themselves, out of the
        workspace.
      </p>
    );
  }

  const isAdmin = member.roles.includes("org_admin");
  const busy = role.isPending || lifecycle.isPending;

  return (
    <div className="space-y-5">
      <Section
        title="Role"
        hint="Admins can invite people, manage members and see the audit trail. Changing a role signs the member out of every device so their new permissions take effect immediately."
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
            {isAdmin ? "Demote to member" : "Make admin"}
          </Button>
        </div>
        {member.status !== "active" && (
          <p className="text-xs text-muted">Reactivate this member before changing their role.</p>
        )}
      </Section>

      <Section
        title="Access"
        hint="Suspending keeps everything and can be undone at any time. Removing revokes the membership — their messages, tasks and history stay exactly where they are, and they can be re-invited later."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={member.status === "active" ? "success" : member.status === "suspended" ? "warning" : "danger"}>
            {member.status}
          </Badge>
          {member.status === "active" ? (
            <>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirm("suspend")}>
                <ShieldOff size={15} /> Suspend
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("remove")}>
                <UserMinus size={15} /> Remove
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
                <UserPlus size={15} /> Reactivate
              </Button>
              {member.status === "suspended" && (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm("remove")}>
                  <UserMinus size={15} /> Remove
                </Button>
              )}
            </>
          )}
        </div>
      </Section>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => !lifecycle.isPending && setConfirm(null)}
        title={confirm === "remove" ? "Remove from workspace?" : "Suspend member?"}
        message={
          confirm === "remove" ? (
            <>
              <strong className="text-fg">{member.displayName}</strong> will lose access to this
              workspace immediately and disappear from the directory. Everything they wrote stays.
              You can invite them back at any time.
            </>
          ) : (
            <>
              <strong className="text-fg">{member.displayName}</strong> will be signed out
              everywhere and won't be able to sign back in until you reactivate them. Nothing is
              deleted.
            </>
          )
        }
        confirmLabel={confirm === "remove" ? "Remove" : "Suspend"}
        danger
        busy={lifecycle.isPending}
        onConfirm={() => lifecycle.mutate(confirm === "remove" ? "remove" : "suspend")}
      />
    </div>
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
