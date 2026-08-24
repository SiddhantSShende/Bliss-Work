import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Avatar, Button, Input } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser } from "../lib/matchUser";

/**
 * Pick teammates. Used to add people to an existing channel; the same shape as
 * the picker inside CreateChannelDialog, which keeps its own copy because it is
 * part of one form rather than a standalone control with confirm/cancel.
 *
 * `exclude` is the set already in the channel (members AND blocked users): a
 * blocked user in this list would be a button that 403s, and re-adding an
 * existing member would silently do nothing.
 */
export function MemberPicker({
  exclude,
  busy,
  onConfirm,
  onCancel,
  onOrganization,
  confirmLabel = "Add",
}: {
  exclude: Set<string>;
  busy?: boolean;
  onConfirm: (userIds: string[]) => void;
  onCancel: () => void;
  /** Optional organization-wide action, offered to organization owners/admins. */
  onOrganization?: (userIds: string[]) => void;
  confirmLabel?: string;
}) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const candidates = users.filter(
    (u) => u.id !== me.id && !exclude.has(u.id) && matchUser(u, q),
  );
  const allSelected = candidates.length > 0 && candidates.every((u) => selected.has(u.id));

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(candidates.map((u) => u.id)));

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-2 rounded-xl border border-border/60 p-3">
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input
          className="h-9 pl-9"
          placeholder="Search teammates…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>
      {candidates.length > 0 && (
        <button
          type="button"
          onClick={toggleAll}
          className="text-xs font-medium text-accent hover:text-accent-strong"
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      )}
      <div className="max-h-56 space-y-0.5 overflow-auto">
        {candidates.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted">Everyone matching is already here.</p>
        ) : (
          candidates.map((u) => {
            const on = selected.has(u.id);
            return (
              <button
                type="button"
                key={u.id}
                onClick={() => toggle(u.id)}
                aria-pressed={on}
                className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${
                  on ? "bg-accent-soft" : "hover:bg-surface-2"
                }`}
              >
                <Avatar name={u.displayName} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{u.displayName}</span>
                <span className="truncate text-xs text-muted">@{u.username}</span>
              </button>
            );
          })
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          loading={busy}
          disabled={selected.size === 0}
          onClick={() => onConfirm([...selected])}
        >
          {confirmLabel} {selected.size || ""}
        </Button>
        {onOrganization && candidates.length > 0 && (
          <Button
            variant="subtle"
            size="sm"
            disabled={busy}
            onClick={() => onOrganization(candidates.map((u) => u.id))}
          >
            Send organization
          </Button>
        )}
      </div>
    </div>
  );
}
