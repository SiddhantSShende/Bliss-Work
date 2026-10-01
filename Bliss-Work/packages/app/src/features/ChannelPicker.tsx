import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Hash, Loader2, Lock, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { PICKER_TONES, type PickerTone } from "./pickerTone";

/**
 * Pick channels, as a FIELD inside a form — the channel counterpart of
 * InviteePicker, with the same shape (a search box over a list of toggles) so
 * the two read as one control.
 *
 * The list is the channels the CALLER is in (`api.channels()`, the same cached
 * query the task and forward dialogs read). That is the only list the server
 * will accept for a meeting too: naming a channel you are not in would be a way
 * to read its membership off the invite list, so the server refuses it.
 *
 * Selection lives with the caller (`selected` / `onToggle`), because the
 * confirm for it is the form's own submit button.
 */
export function ChannelPicker({
  selected,
  onToggle,
  tone = "theme",
  autoFocus = false,
}: {
  selected: Set<string>;
  onToggle: (channelId: string) => void;
  tone?: PickerTone;
  /** Focus the search box on mount — for a picker the user has just opened. */
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const [q, setQ] = useState("");
  const c = PICKER_TONES[tone];

  const {
    data: channels = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? channels.filter((ch) => ch.name.toLowerCase().includes(needle)) : channels;
  }, [channels, q]);

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
          placeholder={t("newMeeting.channelPicker.searchPlaceholder")}
          aria-label={t("newMeeting.channelPicker.searchAriaLabel")}
          autoFocus={autoFocus}
          className={`w-full rounded-lg border py-2 pl-9 pr-3 text-sm outline-none ${c.input}`}
        />
      </div>
      <div className={`max-h-40 overflow-auto rounded-lg border p-1 ${c.list}`}>
        {isLoading ? (
          <p className={`flex items-center gap-2 px-2 py-3 text-sm ${c.muted}`} role="status">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {t("newMeeting.channelPicker.loading")}
          </p>
        ) : isError ? (
          <div className="px-2 py-3 text-sm" role="alert">
            <p className="text-danger">{t("newMeeting.channelPicker.error")}</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="mt-1 font-medium text-accent hover:underline"
            >
              {t("newMeeting.channelPicker.retry")}
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className={`px-2 py-3 text-sm ${c.muted}`}>
            {q ? t("newMeeting.channelPicker.empty.noMatches") : t("newMeeting.channelPicker.empty.none")}
          </p>
        ) : (
          shown.map((ch) => {
            const on = selected.has(ch.id);
            const Icon = ch.isLocked ? Lock : Hash;
            return (
              <button
                type="button"
                key={ch.id}
                onClick={() => onToggle(ch.id)}
                aria-pressed={on}
                className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${on ? c.on : c.off}`}
              >
                <Icon size={15} className={`shrink-0 ${c.muted}`} aria-hidden />
                <span className={`min-w-0 flex-1 truncate text-sm ${c.text}`}>{ch.name}</span>
                <span className={`shrink-0 text-xs ${c.muted}`}>
                  {t("newMeeting.channelPicker.members", { count: ch.memberCount })}
                </span>
                {on && <Check size={15} className="shrink-0 text-accent" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
