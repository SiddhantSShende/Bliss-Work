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
      toast.success("Channel renamed");
      onClose();
    },
    onError: () => toast.error("Couldn't rename the channel"),
  });

  const trimmed = name.trim();

  return (
    <Modal open={open} onClose={onClose} title="Rename channel">
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
          placeholder="Channel name"
          required
        />
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={rename.isPending} disabled={!trimmed}>
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
