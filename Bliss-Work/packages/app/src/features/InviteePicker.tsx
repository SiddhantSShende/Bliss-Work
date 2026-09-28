import { Check, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@taskboard/ui";
import { usePeopleSearch } from "../lib/usePeopleCandidates";
import { PICKER_TONES, type PickerTone } from "./pickerTone";

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
  tone = "theme",
  autoFocus = false,
}: {
  selected: Set<string>;
  onToggle: (userId: string) => void;
  /** Already on the roster — the chat peer, for instance. Offering them would
   *  be offering a seat that is already taken. */
  exclude?: Set<string>;
  tone?: PickerTone;
  /** Focus the search box on mount — for a picker the user has just opened. */
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("org");
  const { q, setQ, candidates, isLoading } = usePeopleSearch(exclude);
  const c = PICKER_TONES[tone];

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search
          size={14}
          className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${c.icon}`}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("org:inviteePicker.searchPlaceholder")}
          aria-label={t("org:inviteePicker.searchAriaLabel")}
          autoFocus={autoFocus}
          className={`w-full rounded-lg border py-2 pl-9 pr-3 text-sm outline-none ${c.input}`}
        />
      </div>
      <div className={`max-h-40 overflow-auto rounded-lg border p-1 ${c.list}`}>
        {candidates.length === 0 ? (
          <p className={`px-2 py-3 text-sm ${c.muted}`}>
            {isLoading
              ? t("org:inviteePicker.loading")
              : q
                ? t("org:inviteePicker.empty.noMatches")
                : t("org:inviteePicker.empty.noneToInvite")}
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
                  on ? c.on : c.off
                }`}
              >
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" className={c.avatar} />
                <span className={`min-w-0 flex-1 truncate text-sm ${c.text}`}>{u.displayName}</span>
                <span className={`shrink-0 truncate text-xs ${c.muted}`}>@{u.username}</span>
                {on && <Check size={15} className="shrink-0 text-accent" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
