import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { usePeopleCandidates } from "../lib/usePeopleCandidates";
import { ChannelPicker } from "./ChannelPicker";
import { InviteePicker } from "./InviteePicker";
import { PICKER_TONES } from "./pickerTone";
import { SelectionField, type SelectionChip } from "./SelectionField";

/**
 * WHO a meeting is for: the members picked one by one, and the channels whose
 * members are all invited. Shared by the create and edit forms so the two cannot
 * drift into offering different controls for the same thing.
 *
 * Selection is the caller's (`Set`s of ids), because it is read alongside the rest
 * of the form at submit. Names come from the same cached directory and channel
 * queries the pickers use. An id with no name — a member deactivated, or a channel
 * deleted, since it was picked — still gets a chip, labelled as unavailable, so an
 * edit form can show it and let the organiser take it out rather than hiding a
 * selection the server still holds.
 */
export function MeetingAudienceFields({
  invitees,
  onToggleInvitee,
  channels,
  onToggleChannel,
}: {
  invitees: Set<string>;
  onToggleInvitee: (userId: string) => void;
  channels: Set<string>;
  onToggleChannel: (channelId: string) => void;
}) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const { all: people } = usePeopleCandidates("");
  const { data: channelList, isLoading: channelsLoading } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
  });

  const memberChips = useMemo<SelectionChip[]>(() => {
    const byId = new Map(people.map((u) => [u.id, u]));
    return [...invitees].map((id) => {
      const u = byId.get(id);
      const label = u?.displayName || u?.username || t("newMeeting.unknownMember");
      // Decorative: the name is right beside it, and the avatar's initials would
      // otherwise be read out as part of it ("GH Grace Hopper").
      return {
        id,
        label,
        leading: (
          <span aria-hidden="true" className="flex">
            <Avatar name={label} src={u?.avatarUrl} size="sm" className={PICKER_TONES.light.avatar} />
          </span>
        ),
      };
    });
  }, [invitees, people, t]);

  const channelChips = useMemo<SelectionChip[]>(() => {
    const byId = new Map((channelList ?? []).map((c) => [c.id, c]));
    return [...channels].map((id) => {
      const c = byId.get(id);
      const label = c ? c.name : channelsLoading ? "…" : t("newMeeting.unknownChannel");
      return {
        id,
        label,
        leading: <Hash size={13} className="ml-1 shrink-0 text-gray-400" aria-hidden />,
      };
    });
  }, [channels, channelList, channelsLoading, t]);

  return (
    <>
      <SelectionField
        label={t("newMeeting.membersLabel")}
        chips={memberChips}
        onRemove={onToggleInvitee}
        removeLabel={(c) => t("newMeeting.membersRemove", { name: c.label })}
        emptyLabel={t("newMeeting.membersNone")}
        addLabel={t("newMeeting.membersAdd")}
        doneLabel={t("newMeeting.membersDone")}
      >
        <InviteePicker tone="light" autoFocus selected={invitees} onToggle={onToggleInvitee} />
      </SelectionField>

      <SelectionField
        label={t("newMeeting.channelsLabel")}
        hint={t("newMeeting.channelsHint")}
        chips={channelChips}
        onRemove={onToggleChannel}
        removeLabel={(c) => t("newMeeting.channelsRemove", { name: c.label })}
        emptyLabel={t("newMeeting.channelsNone")}
        addLabel={t("newMeeting.channelsAdd")}
        doneLabel={t("newMeeting.channelsDone")}
      >
        <ChannelPicker tone="light" autoFocus selected={channels} onToggle={onToggleChannel} />
      </SelectionField>
    </>
  );
}
