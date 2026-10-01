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
import { PICKER_TONES, type PickerTone } from "./pickerTone";
import { SelectionField, type SelectionChip } from "./SelectionField";

/** The wording of the two groups. Defaults to the meeting form's own; the task
 *  form passes its own, so the control is identical and only the words differ. */
export interface AudienceCopy {
  peopleLabel: string;
  peopleNone: string;
  peopleAdd: string;
  peopleDone: string;
  peopleRemove: (name: string) => string;
  unknownPerson: string;
  /** Appended to the caller's own chip — only meaningful with `includeSelf`. */
  you?: string;
  channelsLabel: string;
  channelsHint?: string;
  channelsNone: string;
  channelsAdd: string;
  channelsDone: string;
  channelsRemove: (name: string) => string;
  unknownChannel: string;
}

/**
 * WHO a form is for: the people picked one by one, and the channels picked
 * alongside them. Both groups are always on screen together — opening one
 * picker never hides the other group or its chips — and each shows a live count.
 * Shared by the meeting create/edit forms and the task form, so they cannot
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
  tone = "light",
  includeSelf = false,
  copy,
}: {
  invitees: Set<string>;
  onToggleInvitee: (userId: string) => void;
  channels: Set<string>;
  onToggleChannel: (channelId: string) => void;
  /** "light" for the meeting form's white card, "theme" for a themed Modal. */
  tone?: PickerTone;
  /** Offer (and label) the caller among the people — task assignment only. */
  includeSelf?: boolean;
  copy?: AudienceCopy;
}) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const { all: people, me } = usePeopleCandidates("", undefined, includeSelf);
  const w: AudienceCopy = copy ?? {
    peopleLabel: t("newMeeting.membersLabel"),
    peopleNone: t("newMeeting.membersNone"),
    peopleAdd: t("newMeeting.membersAdd"),
    peopleDone: t("newMeeting.membersDone"),
    peopleRemove: (name) => t("newMeeting.membersRemove", { name }),
    unknownPerson: t("newMeeting.unknownMember"),
    channelsLabel: t("newMeeting.channelsLabel"),
    channelsHint: t("newMeeting.channelsHint"),
    channelsNone: t("newMeeting.channelsNone"),
    channelsAdd: t("newMeeting.channelsAdd"),
    channelsDone: t("newMeeting.channelsDone"),
    channelsRemove: (name) => t("newMeeting.channelsRemove", { name }),
    unknownChannel: t("newMeeting.unknownChannel"),
  };
  const { data: channelList, isLoading: channelsLoading } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
  });

  const { unknownPerson, unknownChannel, you } = w;
  // Only the task form marks the caller; the meeting form never offers them.
  const myId = includeSelf ? me.id : undefined;
  const toneClasses = PICKER_TONES[tone];

  const memberChips = useMemo<SelectionChip[]>(() => {
    const byId = new Map(people.map((u) => [u.id, u]));
    return [...invitees].map((id) => {
      const u = byId.get(id);
      const name = u?.displayName || u?.username || unknownPerson;
      const label = you && id === myId ? `${name} ${you}` : name;
      // Decorative: the name is right beside it, and the avatar's initials would
      // otherwise be read out as part of it ("GH Grace Hopper").
      return {
        id,
        label,
        leading: (
          <span aria-hidden="true" className="flex">
            <Avatar name={name} src={u?.avatarUrl} size="sm" className={toneClasses.avatar} />
          </span>
        ),
      };
    });
  }, [invitees, people, myId, unknownPerson, you, toneClasses.avatar]);

  const channelChips = useMemo<SelectionChip[]>(() => {
    const byId = new Map((channelList ?? []).map((c) => [c.id, c]));
    return [...channels].map((id) => {
      const c = byId.get(id);
      const label = c ? c.name : channelsLoading ? "…" : unknownChannel;
      return {
        id,
        label,
        leading: <Hash size={13} className={`ml-1 shrink-0 ${toneClasses.icon}`} aria-hidden />,
      };
    });
  }, [channels, channelList, channelsLoading, unknownChannel, toneClasses.icon]);

  return (
    <>
      <SelectionField
        tone={tone}
        label={w.peopleLabel}
        count={invitees.size}
        chips={memberChips}
        onRemove={onToggleInvitee}
        removeLabel={(c) => w.peopleRemove(c.label)}
        emptyLabel={w.peopleNone}
        addLabel={w.peopleAdd}
        doneLabel={w.peopleDone}
      >
        <InviteePicker tone={tone} autoFocus includeSelf={includeSelf} selected={invitees} onToggle={onToggleInvitee} />
      </SelectionField>

      <SelectionField
        tone={tone}
        label={w.channelsLabel}
        count={channels.size}
        hint={w.channelsHint}
        chips={channelChips}
        onRemove={onToggleChannel}
        removeLabel={(c) => w.channelsRemove(c.label)}
        emptyLabel={w.channelsNone}
        addLabel={w.channelsAdd}
        doneLabel={w.channelsDone}
      >
        <ChannelPicker tone={tone} autoFocus selected={channels} onToggle={onToggleChannel} />
      </SelectionField>
    </>
  );
}
