import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Hash, Lock, Globe, UserPlus, X } from "lucide-react";
import { Avatar, Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { usePeopleCandidates } from "../lib/usePeopleCandidates";
import { useToggleSet } from "../lib/useToggleSet";
import { MemberPicker } from "./MemberPicker";
import { Field } from "../routes/Onboarding";

/**
 * "Create New Channel" content — the create-tab of the "+" popup
 * (AddChannelDialog). Split out of what used to be its own nested dialog so
 * the popup can hold it and the browse/join tab side by side without
 * stacking a second modal.
 *
 * Member picking is the standalone MemberPicker (same component
 * ChannelMembersSheet uses to add people to an EXISTING channel), not a
 * hand-rolled copy — nothing here is submitted until the whole form's Create
 * button is pressed, so MemberPicker's onConfirm only updates local state.
 */
export function CreateChannelPanel({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation("chatList");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState("");
  /** Locked channels admit members only via explicit add (legacy invite path).
   *  Open channels accept self-join from anyone in the org. Defaults to open
   *  since most channels in a small team are discoverable. */
  const [isLocked, setIsLocked] = useState(false);
  const [picking, setPicking] = useState(false);

  const { selected, setSelected, toggle } = useToggleSet();
  // Resolves the selected ids to display info for the member list below.
  // Shares the already-cached org-directory query MemberPicker itself reads,
  // so this costs no extra request.
  const { all } = usePeopleCandidates("");
  const byId = new Map(all.map((u) => [u.id, u]));

  const create = useMutation({
    mutationFn: () => api.createChannel({ name: name.trim(), memberIds: [...selected], isLocked }),
    onSuccess: (ch) => {
      qc.invalidateQueries({ queryKey: qk.channels });
      qc.invalidateQueries({ queryKey: qk.openChannels });
      onCreated();
      nav(`/app/channels/${ch.id}`);
    },
    onError: (e) => toast.error(t("createChannel.createErrorToast"), { description: String(e) }),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return toast.error(t("createChannel.nameRequiredToast"));
        create.mutate();
      }}
      className="flex flex-col gap-3.5"
    >
      <Field label={t("createChannel.channelNameLabel")}>
        <div className="relative">
          <Hash size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input className="pl-9" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("createChannel.channelNamePlaceholder")} required />
        </div>
      </Field>
      <Field label={t("createChannel.visibilityLabel")}>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setIsLocked(false)}
            className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
              !isLocked ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"
            }`}
          >
            <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <Globe size={14} /> {t("createChannel.openOption.label")}
            </div>
            <div className="text-[11px] text-muted">{t("createChannel.openOption.hint")}</div>
          </button>
          <button
            type="button"
            onClick={() => setIsLocked(true)}
            className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition ${
              isLocked ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"
            }`}
          >
            <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
              <Lock size={14} /> {t("createChannel.lockedOption.label")}
            </div>
            <div className="text-[11px] text-muted">{t("createChannel.lockedOption.hint")}</div>
          </button>
        </div>
      </Field>
      <Field label={selected.size ? t("createChannel.membersLabelWithCount", { count: selected.size }) : t("createChannel.membersLabel")}>
        <div className="flex flex-col gap-2">
          {selected.size === 0 ? (
            <p className="rounded-xl border border-border p-3 text-sm text-muted">{t("createChannel.noMembers")}</p>
          ) : (
            <ul className="m-0 max-h-40 list-none space-y-0.5 overflow-auto rounded-xl border border-border p-1">
              {[...selected].map((id) => {
                const u = byId.get(id);
                return (
                  <li key={id} className="flex items-center gap-2.5 rounded-lg p-2">
                    <Avatar name={u?.displayName ?? "?"} src={u?.avatarUrl} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{u?.displayName ?? id}</span>
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      aria-label={t("createChannel.removeMemberAriaLabel", { name: u?.displayName ?? t("createChannel.removeMemberFallback") })}
                      className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                    >
                      <X size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {picking ? (
            <MemberPicker
              exclude={selected}
              onCancel={() => setPicking(false)}
              onConfirm={(ids) => {
                setSelected((s) => new Set([...s, ...ids]));
                setPicking(false);
              }}
            />
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={() => setPicking(true)}>
              <UserPlus size={14} /> {t("createChannel.addMember")}
            </Button>
          )}
        </div>
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <Button type="submit" loading={create.isPending}>
          {create.isPending ? t("createChannel.creating") : t("createChannel.createButton")}
        </Button>
      </div>
    </form>
  );
}
