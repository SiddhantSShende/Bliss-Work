import { Check, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@taskboard/ui";
import { usePeopleSearch } from "../lib/usePeopleCandidates";

/**
 * Pick extra people from the organisation, as a FIELD inside a form.
 *
 * MemberPicker is the standalone version of this and owns its own confirm and
 * cancel, which is right for "Add people to this call" and wrong here: the
 * confirm for this selection is the form's own submit button, and the selection
 * has to be read alongside the rest of the form rather than acted on by itself.
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
  const { t } = useTranslation("org");
  const { q, setQ, candidates } = usePeopleSearch(exclude);

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
          placeholder={t("org:inviteePicker.searchPlaceholder")}
          aria-label={t("org:inviteePicker.searchAriaLabel")}
          className="w-full rounded-lg border border-border bg-surface-2 py-2 pl-9 pr-3 text-sm text-fg outline-none focus:border-accent"
        />
      </div>
      <div className="max-h-40 overflow-auto rounded-lg border border-border p-1">
        {candidates.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">
            {q ? t("org:inviteePicker.empty.noMatches") : t("org:inviteePicker.empty.noneToInvite")}
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
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
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
