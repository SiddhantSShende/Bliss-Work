/**
 * "Available" bucket — who on the team is free to take work right now.
 *
 * Available = zero ACKNOWLEDGED tasks (see lib/useAvailability for the rule and
 * why the roster is a client-side join of the directory with task-svc counts).
 * Clicking a card opens "New task" with that person preselected, so the pane is
 * an allocation surface rather than a read-only report.
 *
 * Org admins additionally get a hide / un-hide control. Hiding is ORG-WIDE and
 * an ORGANISATIONAL filter, not a permission — the hidden set ships to every
 * client because the roster is assembled there. A hidden person still sees their
 * own card, badged, so they know why nobody is allocating to them.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { Eye, EyeOff, Search, UserCheck } from "lucide-react";
import { Avatar, Badge, Button, EmptyState, GlassCard, IconButton, Input, Spinner } from "@taskboard/ui";
import type { AvailabilityDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser, rankUsers } from "../lib/matchUser";
import { type AvailablePerson, useAvailability } from "../lib/useAvailability";
import { useOnCall, type UserStatus } from "../lib/usePresence";

export function AvailablePeople({ onAssign }: { onAssign: (u: UserDTO) => void }) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const [q, setQ] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const { roster, hidden, hiddenBusy, hiddenSelf, canManage, isLoading } = useAvailability();

  const { data: online = [] } = useQuery({
    queryKey: qk.presence,
    queryFn: () => api.presence(),
    refetchInterval: 20_000,
  });
  const onlineSet = new Set(online);
  // Who is mid-call. This screen exists to answer "who can take work right
  // now", so somebody sitting in a meeting showing as plain Available is the
  // wrong answer to the only question it is asked.
  const onCall = useOnCall();

  const setHidden = useMutation({
    mutationFn: ({ userId, hide }: { userId: string; hide: boolean }) =>
      hide ? api.hideAvailableUser(userId) : api.unhideAvailableUser(userId),
    // Optimistic: patch hiddenUserIds in place so the card moves between the
    // roster and the hidden section instantly. Same snapshot/rollback shape as
    // the task-action mutation in routes/Tasks.tsx.
    onMutate: async ({ userId, hide }) => {
      await qc.cancelQueries({ queryKey: qk.availability });
      const prev = qc.getQueryData<AvailabilityDTO>(qk.availability);
      qc.setQueryData<AvailabilityDTO>(qk.availability, (d) =>
        d && {
          ...d,
          hiddenUserIds: hide
            ? [...new Set([...d.hiddenUserIds, userId])]
            : d.hiddenUserIds.filter((id) => id !== userId),
        },
      );
      return { prev };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(qk.availability, ctx.prev);
      toast.error(vars.hide ? "Couldn't hide that person" : "Couldn't restore that person", {
        description: String(err),
      });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.availability }),
  });

  // rankUsers works on UserDTOs, so filter/rank the users and map back.
  const ranked = (list: AvailablePerson[]) => {
    const byId = new Map(list.map((p) => [p.user.id, p]));
    return rankUsers(
      list.filter((p) => matchUser(p.user, q)).map((p) => p.user),
      q,
    ).map((u) => byId.get(u.id)!);
  };

  const results = ranked(roster);
  // `busy` distinguishes "hidden and free" from "hidden and currently working":
  // un-hiding the latter won't put them back on the roster yet, and the admin
  // needs to be told that rather than think the button failed.
  const hiddenAll = [
    ...hidden.map((p) => ({ p, busy: false })),
    ...hiddenBusy.map((p) => ({ p, busy: true })),
  ];

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative max-w-sm">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <Input
          className="h-10 pl-9"
          placeholder="Search teammates…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {results.length === 0 ? (
        <EmptyState
          icon={<UserCheck size={24} />}
          title={q ? "No matches" : "Everyone's busy"}
          hint={
            q
              ? "No available teammate matches that search."
              : "People with no acknowledged tasks appear here."
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence initial={false}>
            {results.map((p) => (
              <motion.div
                key={p.user.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
              >
                <PersonCard
                  person={p}
                  isMe={p.user.id === me.id}
                  hiddenSelf={p.user.id === me.id && hiddenSelf}
                  status={
                    onCall.has(p.user.id)
                      ? "busy"
                      : onlineSet.has(p.user.id)
                        ? "online"
                        : "offline"
                  }
                  onAssign={() => onAssign(p.user)}
                  onHide={
                    canManage
                      ? () => setHidden.mutate({ userId: p.user.id, hide: true })
                      : undefined
                  }
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {canManage && hiddenAll.length > 0 && (
        <div className="border-t border-border/60 pt-3">
          <Button variant="ghost" size="sm" onClick={() => setShowHidden((v) => !v)}>
            <EyeOff size={14} /> Hidden from this list ({hiddenAll.length})
          </Button>
          {showHidden && (
            <div className="mt-2 flex flex-col divide-y divide-border/50">
              {hiddenAll.map(({ p, busy }) => (
                <div key={p.user.id} className="flex items-center gap-2.5 py-2">
                  <Avatar name={p.user.displayName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg">{p.user.displayName}</div>
                    <div className="truncate text-xs text-muted">
                      {busy
                        ? "Has active tasks — won't reappear until they're free"
                        : `@${p.user.username}`}
                    </div>
                  </div>
                  <IconButton
                    title="Restore to Available"
                    onClick={() => setHidden.mutate({ userId: p.user.id, hide: false })}
                  >
                    <Eye size={16} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PersonCard({
  person: p,
  isMe,
  hiddenSelf,
  status,
  onAssign,
  onHide,
}: {
  person: AvailablePerson;
  isMe: boolean;
  hiddenSelf: boolean;
  status: UserStatus;
  onAssign: () => void;
  onHide?: () => void;
}) {
  return (
    <GlassCard className="relative">
      <button
        type="button"
        onClick={onAssign}
        title={`Allocate a task to ${p.user.displayName}`}
        className="flex w-full items-center gap-3 rounded-2xl p-4 text-left transition-colors hover:bg-surface-2/60"
      >
        <Avatar name={p.user.displayName} status={status} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-fg">
            {p.user.displayName}
            {isMe && <span className="text-muted"> (you)</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span className="truncate">@{p.user.username}</span>
            {p.pending > 0 && (
              <Badge tone="neutral">
                {p.pending} pending, unacked
              </Badge>
            )}
            {status === "busy" && <Badge tone="warning">on a call</Badge>}
            {hiddenSelf && <Badge tone="neutral">hidden from others</Badge>}
          </div>
        </div>
      </button>
      {onHide && (
        <IconButton
          title="Hide from Available"
          // Overlays the card's own click target (which opens the task dialog),
          // so swallow the event rather than allocating on a hide.
          onClick={(e) => {
            e.stopPropagation();
            onHide();
          }}
          className="absolute right-1.5 top-1.5 h-8 w-8"
        >
          <EyeOff size={15} />
        </IconButton>
      )}
    </GlassCard>
  );
}
