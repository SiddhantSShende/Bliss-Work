import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, Crown, ShieldCheck, ShieldOff, UserMinus, UserPlus } from "lucide-react";
import { Avatar, Badge, Button, Spinner } from "@taskboard/ui";
import type { ChannelDTO, ChannelRole, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { canModerateChannel } from "../lib/messagePermissions";
import { ConfirmDialog } from "./ConfirmDialog";
import { Sheet } from "./Modal";
import { MemberPicker } from "./MemberPicker";

/**
 * Who is in this channel, what standing they have, and what a manager can do
 * about it.
 *
 * Every action is gated on `canManage` here AND re-checked server-side — the
 * client gate exists so people are not shown buttons that will 403, not as the
 * control. An org_admin can moderate a channel they are not even in, which is
 * why `canManage` is not simply "am I the owner".
 */
export function ChannelMembersSheet({
  open,
  onClose,
  channel,
}: {
  open: boolean;
  onClose: () => void;
  channel: ChannelDTO;
}) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const isOrgAdmin = me.roles.includes("org_admin");
  const [adding, setAdding] = useState(false);
  const [transferTarget, setTransferTarget] = useState<{ userId: string; displayName: string } | null>(null);
  const [blockTarget, setBlockTarget] = useState<{ userId: string; displayName: string } | null>(null);

  const canManage = canModerateChannel(channel, me);
  // Only an owner (or an org admin) may change roles — an admin cannot mint
  // more admins, so the moderator set stays something the owner chose.
  const canSetRoles = isOrgAdmin || channel.myRole === "owner";

  const { data: roster = [], isLoading } = useQuery({
    queryKey: qk.channelRoster(channel.id),
    queryFn: () => api.channelRoster(channel.id),
    enabled: open,
  });
  const { data: directory = [] } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
    enabled: open,
  });

  const byId = new Map(directory.map((u: UserDTO) => [u.id, u]));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.channelRoster(channel.id) });
    qc.invalidateQueries({ queryKey: qk.channels });
  };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Action failed");

  const act = useMutation({
    mutationFn: (op: { kind: "kick" | "block" | "unblock" | "role"; userId: string; role?: ChannelRole }) => {
      if (op.kind === "kick") return api.kickChannelMember(channel.id, op.userId);
      if (op.kind === "block") return api.blockFromChannel(channel.id, op.userId);
      if (op.kind === "unblock") return api.unblockFromChannel(channel.id, op.userId);
      return api.setChannelMemberRole(channel.id, op.userId, op.role!);
    },
    onSuccess: refresh,
    onError: fail,
  });

  const add = useMutation({
    mutationFn: (userIds: string[]) => api.addChannelMembers(channel.id, userIds),
    onSuccess: () => {
      setAdding(false);
      refresh();
      toast.success("Added to the channel");
    },
    onError: fail,
  });

  const members = roster.filter((r) => !r.blocked);
  const blocked = roster.filter((r) => r.blocked);
  const memberIds = new Set(roster.map((r) => r.userId));

  return (
    <Sheet open={open} onClose={onClose} title={`#${channel.name}`}>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">
            {members.length} member{members.length === 1 ? "" : "s"}
          </p>
          {canManage && !adding && (
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              <UserPlus size={15} /> Add people
            </Button>
          )}
        </div>

        {adding && (
          <MemberPicker
            exclude={memberIds}
            busy={add.isPending}
            onCancel={() => setAdding(false)}
            onConfirm={(ids) => add.mutate(ids)}
          />
        )}

        {isLoading ? (
          <div className="flex justify-center p-6"><Spinner /></div>
        ) : (
          <ul className="m-0 list-none space-y-0.5 p-0">
            {members.map((m) => {
              const u = byId.get(m.userId);
              const isMe = m.userId === me.id;
              // The owner is never removable and never demotable — the channel
              // must keep one. Transferring ownership is the way out.
              const protectedRow = m.role === "owner";
              return (
                <li key={m.userId} className="group flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2">
                  <Avatar name={u?.displayName ?? m.userId} src={u?.avatarUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-fg">
                        {u?.displayName ?? m.userId}{isMe && " (you)"}
                      </span>
                      {m.role !== "member" && (
                        <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
                      )}
                      {/* Their ORG role, alongside their channel role — the two
                          are different things and admins conflate them. */}
                      {u?.roles.includes("org_admin") && <Badge tone="neutral">Workspace admin</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted">@{u?.username ?? "unknown"}</div>
                  </div>
                  {canManage && !isMe && !protectedRow && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                      {canSetRoles && (
                        <Action
                          title={m.role === "admin" ? "Remove as channel admin" : "Make channel admin"}
                          disabled={act.isPending}
                          onClick={() => act.mutate({
                            kind: "role", userId: m.userId,
                            role: m.role === "admin" ? "member" : "admin",
                          })}
                        >
                          {m.role === "admin" ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
                        </Action>
                      )}
                      {canSetRoles && (
                        <Action
                          title="Transfer ownership"
                          disabled={act.isPending}
                          onClick={() => setTransferTarget({ userId: m.userId, displayName: u?.displayName ?? "them" })}
                        >
                          <Crown size={15} />
                        </Action>
                      )}
                      <Action
                        title="Remove from channel"
                        disabled={act.isPending}
                        onClick={() => act.mutate({ kind: "kick", userId: m.userId })}
                      >
                        <UserMinus size={15} />
                      </Action>
                      <Action
                        title="Block from channel"
                        danger
                        disabled={act.isPending}
                        onClick={() => setBlockTarget({ userId: m.userId, displayName: u?.displayName ?? "them" })}
                      >
                        <Ban size={15} />
                      </Action>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {blocked.length > 0 && canManage && (
          <section className="space-y-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Blocked</h4>
            <ul className="m-0 list-none space-y-0.5 p-0">
              {blocked.map((b) => {
                const u = byId.get(b.userId);
                return (
                  <li key={b.userId} className="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2">
                    <Avatar name={u?.displayName ?? b.userId} src={u?.avatarUrl} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm text-muted">
                      {u?.displayName ?? b.userId}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ kind: "unblock", userId: b.userId })}
                    >
                      Unblock
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      <ConfirmDialog
        open={transferTarget !== null}
        onClose={() => setTransferTarget(null)}
        title="Transfer ownership?"
        message={`Make ${transferTarget?.displayName ?? "them"} the owner of #${channel.name}? You'll become an admin.`}
        confirmLabel="Transfer"
        danger
        busy={act.isPending}
        onConfirm={() => {
          if (!transferTarget) return;
          act.mutate(
            { kind: "role", userId: transferTarget.userId, role: "owner" },
            { onSuccess: () => setTransferTarget(null) },
          );
        }}
      />
      <ConfirmDialog
        open={blockTarget !== null}
        onClose={() => setBlockTarget(null)}
        title="Block from channel?"
        message={`Block ${blockTarget?.displayName ?? "them"} from #${channel.name}? They'll be removed and can't rejoin.`}
        confirmLabel="Block"
        danger
        busy={act.isPending}
        onConfirm={() => {
          if (!blockTarget) return;
          act.mutate(
            { kind: "block", userId: blockTarget.userId },
            { onSuccess: () => setBlockTarget(null) },
          );
        }}
      />
    </Sheet>
  );
}

function Action({
  title, onClick, disabled, danger, children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg p-1.5 text-muted transition hover:bg-surface disabled:opacity-40 ${
        danger ? "hover:text-danger" : "hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
