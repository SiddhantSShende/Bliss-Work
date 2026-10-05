import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash, Lock, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { usePeopleCandidates } from "../lib/usePeopleCandidates";
import { useToggleSet } from "../lib/useToggleSet";
import { ChannelPicker } from "./ChannelPicker";
import { InviteePicker } from "./InviteePicker";

/** What the "Add participants" dialog hands back: both kinds, submitted together. */
export interface ParticipantTargets {
  userIds: string[];
  channelIds: string[];
}

type Tab = "people" | "channels";

/**
 * The body of the "Add participants" dialog: people AND channels, picked in any
 * order and confirmed together with one button.
 *
 * Built from the same two controlled field pickers the New Task form uses
 * (InviteePicker, ChannelPicker) so a person or channel is picked the same way
 * everywhere. Each owns only its search box and list; the selection lives HERE,
 * so switching tabs keeps what was already picked, and one Set per kind makes a
 * duplicate selection impossible.
 *
 * `excludeUserIds` are people already on the task. Channels are not excluded: the
 * server treats re-attaching one as a no-op, and a channel whose members are all
 * present is still worth attaching so a later joiner is added too.
 */
export function AddParticipantsPicker({
  excludeUserIds,
  busy,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  excludeUserIds: Set<string>;
  busy?: boolean;
  confirmLabel: string;
  onConfirm: (targets: ParticipantTargets) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const [tab, setTab] = useState<Tab>("people");
  const people = useToggleSet();
  const channels = useToggleSet();
  const { all: directory } = usePeopleCandidates("", excludeUserIds);
  const { data: channelList = [] } = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
  const total = people.selected.size + channels.selected.size;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "people", label: t("participants.tabPeople"), count: people.selected.size },
    { id: "channels", label: t("participants.tabChannels"), count: channels.selected.size },
  ];

  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-3">
      <div role="tablist" aria-label={t("participants.addTitle")} className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
        {tabs.map(({ id, label, count }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`add-participants-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="add-participants-panel"
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}
          >
            {label}
            {count > 0 && <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 text-xs text-accent">{count}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="add-participants-panel" aria-labelledby={`add-participants-tab-${tab}`}>
        {tab === "people" ? (
          <InviteePicker autoFocus exclude={excludeUserIds} selected={people.selected} onToggle={people.toggle} />
        ) : (
          <ChannelPicker autoFocus selected={channels.selected} onToggle={channels.toggle} />
        )}
      </div>

      {total > 0 && (
        <ul aria-label={t("participants.selected")} className="flex flex-wrap gap-1.5">
          {[...people.selected].map((id) => {
            const user = directory.find((u) => u.id === id);
            const name = user?.displayName || user?.username || t("participants.unknownPerson");
            return (
              <SelectedChip
                key={`u-${id}`}
                kind="person"
                label={name}
                leading={<Avatar name={name} src={user?.avatarUrl} size="sm" />}
                removeLabel={t("participants.removeSelected", { name })}
                onRemove={() => people.toggle(id)}
              />
            );
          })}
          {[...channels.selected].map((id) => {
            const channel = channelList.find((c) => c.id === id);
            const name = channel?.name ?? t("participants.unknownChannel");
            const Icon = channel?.isLocked ? Lock : Hash;
            return (
              <SelectedChip
                key={`c-${id}`}
                kind="channel"
                label={name}
                leading={<Icon size={13} aria-hidden />}
                removeLabel={t("participants.removeSelected", { name })}
                onRemove={() => channels.toggle(id)}
              />
            );
          })}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t("org:memberPicker.cancelButton")}
        </Button>
        <Button
          size="sm"
          loading={busy}
          disabled={total === 0}
          onClick={() => onConfirm({ userIds: [...people.selected], channelIds: [...channels.selected] })}
        >
          {confirmLabel} {total || ""}
        </Button>
      </div>
    </div>
  );
}

/** A channel chip is dashed and accent-tinted, a person's is a plain pill: the two
 *  read apart at a glance as well as by their avatar / "#" lead. */
function SelectedChip({
  kind,
  label,
  leading,
  removeLabel,
  onRemove,
}: {
  kind: "person" | "channel";
  label: string;
  leading: React.ReactNode;
  removeLabel: string;
  onRemove: () => void;
}) {
  const { t } = useTranslation("tasks");
  const tone = kind === "channel" ? "border-dashed border-accent/60 bg-accent-soft text-fg" : "border-border bg-surface-2 text-fg";
  return (
    <li
      data-kind={kind}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border py-0.5 pl-1.5 pr-1 text-xs ${tone}`}
    >
      <span className="flex shrink-0 items-center text-muted">{leading}</span>
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
        {kind === "channel" ? t("participants.kindChannel") : t("participants.kindPerson")}
      </span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted hover:bg-border hover:text-fg"
      >
        <X size={11} aria-hidden />
      </button>
    </li>
  );
}
