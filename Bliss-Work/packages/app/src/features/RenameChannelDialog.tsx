/**
 * Rename a channel.
 *
 * Used to be `window.prompt()`. Electron's renderer does not implement
 * `window.prompt()` — it throws "Error: prompt() is not supported." — so the
 * desktop app crashed uncaught the moment anyone opened Rename. This dialog
 * is the same interaction (prefilled with the current name, no-op if left
 * unchanged or emptied) built out of the app's own Modal instead of a
 * browser-native prompt that only ever worked in the web build.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { Modal } from "./Modal";

export function RenameChannelDialog({
  open,
  onClose,
  channelId,
  currentName,
}: {
  open: boolean;
  onClose: () => void;
  channelId: string;
  currentName: string;
}) {
  const { t } = useTranslation("chatList");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [name, setName] = useState(currentName);

  useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);

  const rename = useMutation({
    mutationFn: (next: string) => api.renameChannel(channelId, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.channels });
      toast.success(t("renameChannel.successToast"));
      onClose();
    },
    onError: () => toast.error(t("renameChannel.errorToast")),
  });

  const trimmed = name.trim();

  return (
    <Modal open={open} onClose={onClose} title={t("renameChannel.title")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed === currentName) {
            onClose();
            return;
          }
          rename.mutate(trimmed);
        }}
        className="flex flex-col gap-3.5"
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("renameChannel.placeholder")}
          required
        />
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={rename.isPending} disabled={!trimmed}>
            {rename.isPending ? t("renameChannel.saving") : t("renameChannel.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
