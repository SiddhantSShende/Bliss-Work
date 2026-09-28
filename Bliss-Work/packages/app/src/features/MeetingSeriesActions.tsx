import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { Button } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { ConfirmDialog } from "./ConfirmDialog";
import { EditMeetingSeriesDialog } from "./EditMeetingSeriesDialog";

/**
 * Edit and cancel for the series a meeting belongs to — its ORGANISER's controls,
 * absent for everyone else (the server decides the same thing; this only avoids
 * offering a button that would answer 403).
 *
 * They act on the whole series, not on the occurrence being viewed, and the
 * confirmation says so: the natural reading of a "Cancel" on one meeting's page is
 * "cancel this meeting", which is not what happens.
 */
export function MeetingSeriesActions({ call }: { call: CallDTO }) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();
  const viewerId = useSession((s) => s.user?.id ?? null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const series = call.series;

  const cancel = useMutation({
    mutationFn: () => api.cancelMeetingSeries(series!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.calls });
      setConfirming(false);
      toast.success(t("series.cancelSeries.done"));
      // The meeting on screen may be one that was just removed.
      nav("/app/meetings");
    },
    onError: () => toast.error(t("series.cancelSeries.error")),
  });

  if (!series || series.status === "CANCELLED" || call.createdBy !== viewerId) return null;

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
        <Pencil size={14} aria-hidden />
        {t("series.edit.button")}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}>
        {t("series.cancelSeries.button")}
      </Button>
      {editing && <EditMeetingSeriesDialog seriesId={series.id} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("series.cancelSeries.title")}
        message={t("series.cancelSeries.message")}
        confirmLabel={t("series.cancelSeries.confirm")}
        danger
        busy={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </>
  );
}
