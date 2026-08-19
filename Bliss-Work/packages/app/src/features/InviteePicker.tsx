import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser } from "../lib/matchUser";

/**
 * Pick extra people from the organisation, as a FIELD inside a form.
 *
 * MemberPicker is the standalone version of this and owns its own confirm and
 * cancel, which is right for "Add people to this call" and wrong here: the
 * confirm for this selection is the form's own submit button, and the selection
 * has to be read alongside the rest of the form rather than acted on by itself.
 * CreateChannelDialog makes the same choice for the same reason.
 *
 * The list is the caller's ACTIVE organisation, which is the only roster the
 * server will accept: every participant on a call must belong to the hosting
 * org, and cross-org attendance exists on the meeting-link path alone.
 */
export function InviteePicker({
  selected,
  onToggle,
  exclude,
}: {
  selected: Set<string>;
  onToggle: (userId: string) => void;
  /** Already on the roster — the chat peer, for instance. Offering them would
   *  be offering a seat that is already taken. */
  exclude?: Set<string>;
}) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const [q, setQ] = useState("");

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const candidates = users.filter((u) => u.id !== me.id && !exclude?.has(u.id) && matchUser(u, q));

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your organisation…"
          aria-label="Search your organisation"
          className="w-full rounded-lg border border-border bg-surface-2 py-2 pl-9 pr-3 text-sm text-fg outline-none focus:border-accent"
        />
      </div>
      <div className="max-h-40 overflow-auto rounded-lg border border-border p-1">
        {candidates.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">
            {q ? "No matches." : "No one else to invite."}
          </p>
        ) : (
          candidates.map((u) => {
            const on = selected.has(u.id);
            return (
              <button
                type="button"
                key={u.id}
                onClick={() => onToggle(u.id)}
                aria-pressed={on}
                className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${
                  on ? "bg-accent-soft" : "hover:bg-surface-2"
                }`}
              >
                <Avatar name={u.displayName} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{u.displayName}</span>
                <span className="shrink-0 truncate text-xs text-muted">@{u.username}</span>
                {on && <Check size={15} className="shrink-0 text-accent" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
