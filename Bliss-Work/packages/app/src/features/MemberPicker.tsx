import { Search } from "lucide-react";
import { Avatar, Button, Input } from "@taskboard/ui";
import { usePeopleSearch } from "../lib/usePeopleCandidates";
import { useToggleSet } from "../lib/useToggleSet";

/**
 * Pick teammates. Used to add people to an existing channel (ChannelMembersSheet)
 * and, identically, to add initial members while creating a new one
 * (CreateChannelPanel) — both just accumulate ids locally until their own
 * form/mutation submits.
 *
 * `exclude` is the set already in the channel (members AND blocked users) for
 * ChannelMembersSheet, or the already-picked set for CreateChannelPanel: a
 * blocked user in this list would be a button that 403s, and re-adding an
 * existing/already-picked member would silently do nothing useful.
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
  const { q, setQ, candidates } = usePeopleSearch(exclude);
  const { selected, toggle, setAll, clear } = useToggleSet();
  const allSelected = candidates.length > 0 && candidates.every((u) => selected.has(u.id));

  const toggleAll = () => (allSelected ? clear() : setAll(candidates.map((u) => u.id)));

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
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
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
