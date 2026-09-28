import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { AlertCircle, Save } from "lucide-react";
import { ApiError, type MeetingSeriesDTO } from "@taskboard/shared";
import { Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useToggleSet } from "../lib/useToggleSet";
import {
  dateInZone,
  formFromRecurrence,
  toRecurrenceInput,
  validateRecurrence,
  type RecurrenceForm,
} from "../lib/meetingRecurrence";
import { MeetingAudienceFields } from "./MeetingAudienceFields";
import { MeetingDialogShell } from "./MeetingDialogShell";
import { MeetingRepeatField } from "./MeetingRepeatField";

/**
 * Edit a repeating meeting: its title, who it is for, and how it repeats.
 *
 * What is edited is the SERIES. There is no editing of one occurrence, because
 * there is no editing of any meeting; and saving replaces the series' UPCOMING
 * occurrences, keeping the ones that have already happened (the note in the form
 * says so, because "did my edit rewrite last week's meeting?" is the obvious
 * worry). The first meeting's date and time are shown but not editable: they
 * anchor the schedule ("every 2 weeks" counts from that week), and moving them
 * would be a different edit.
 *
 * Restores exactly what was picked — the members and channels themselves, not
 * the roster of any one occurrence, which also holds the channels' members and
 * the organiser — from GET /meeting-series/{id}, which only the organiser may
 * read.
 */
export function EditMeetingSeriesDialog({
  seriesId,
  onClose,
}: {
  seriesId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const { data: series, isLoading, isError, refetch } = useQuery({
    queryKey: qk.meetingSeries(seriesId),
    queryFn: () => api.meetingSeries(seriesId),
  });

  if (series) return <EditForm series={series} onClose={onClose} />;
  return (
    <MeetingDialogShell
      title={t("series.edit.title")}
      closeLabel={t("series.edit.close")}
      onClose={onClose}
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500" role="status">
          <Spinner /> {t("series.edit.loading")}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="flex items-center gap-2 text-sm text-gray-700">
            <AlertCircle size={16} className="text-danger" aria-hidden />
            {isError ? t("series.edit.error") : null}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-sm font-medium text-accent hover:underline"
          >
            {t("series.edit.retry")}
          </button>
        </div>
      )}
    </MeetingDialogShell>
  );
}

function EditForm({ series, onClose }: { series: MeetingSeriesDTO; onClose: () => void }) {
  const { t, i18n } = useTranslation("meetings");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const zone = series.recurrence.timeZone;

  const [title, setTitle] = useState(series.title);
  const invitees = useToggleSet(series.inviteeIds);
  const channels = useToggleSet(series.channelIds);
  const [recurrence, setRecurrence] = useState<RecurrenceForm>(() =>
    formFromRecurrence(series.recurrence),
  );
  const [attempted, setAttempted] = useState(false);

  // The first meeting's date on the ORGANISER's wall: what an end date may not
  // precede, and what the form's rules are stated against.
  const startDate = useMemo(() => dateInZone(series.startAt, zone), [series.startAt, zone]);
  const firstMeeting = useMemo(
    () =>
      new Date(series.startAt).toLocaleString(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: zone,
      }),
    [series.startAt, zone, i18n.language],
  );

  const titleError = !title.trim() ? t("newMeeting.errors.titleRequired") : undefined;
  const recurrenceErrors = validateRecurrence(t, recurrence, startDate);
  const hasErrors = !!titleError || Object.keys(recurrenceErrors).length > 0;

  const save = useMutation({
    mutationFn: () =>
      api.updateMeetingSeries(series.id, {
        title: title.trim(),
        inviteeIds: [...invitees.selected],
        channelIds: [...channels.selected],
        recurrence: toRecurrenceInput(recurrence, startDate, zone),
      }),
    onSuccess: () => {
      // The ["calls"] prefix covers the lists, the calendar windows, this series
      // and every occurrence's own detail.
      void qc.invalidateQueries({ queryKey: qk.calls });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 403) {
        toast.error(t("newMeeting.errors.peopleUnavailable"));
      } else if (err instanceof ApiError && err.status === 400) {
        // The rule names what is wrong ("…has no upcoming meetings; cancel the
        // series instead"), which is more use than a generic failure.
        toast.error(err.message);
      } else {
        toast.error(t("series.edit.saveError"));
      }
    },
  });

  const submit = () => {
    if (save.isPending) return; // Enter while a save is in flight must not save twice.
    if (hasErrors) {
      setAttempted(true);
      return;
    }
    save.mutate();
  };

  return (
    <MeetingDialogShell
      title={t("series.edit.title")}
      closeLabel={t("series.edit.close")}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            {t("series.edit.cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={save.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:brightness-105 disabled:opacity-60"
          >
            <Save size={15} aria-hidden />
            {save.isPending ? t("series.edit.saving") : t("series.edit.save")}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-gray-700">{t("newMeeting.titleLabel")}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("newMeeting.titlePlaceholder")}
          maxLength={200}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent"
        />
        {attempted && titleError && <span className="text-xs text-danger">{titleError}</span>}
      </label>

      <p className="text-xs text-gray-500">{t("series.edit.first", { when: firstMeeting })}</p>

      <MeetingRepeatField
        value={recurrence}
        onChange={setRecurrence}
        startDate={startDate}
        errors={attempted ? recurrenceErrors : undefined}
        allowNone={false}
      />

      <MeetingAudienceFields
        invitees={invitees.selected}
        onToggleInvitee={invitees.toggle}
        channels={channels.selected}
        onToggleChannel={channels.toggle}
      />

      <p className="text-xs text-gray-500">{t("series.edit.note")}</p>
    </MeetingDialogShell>
  );
}
