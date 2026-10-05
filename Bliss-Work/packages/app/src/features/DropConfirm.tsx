import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, Upload } from "lucide-react";
import { Button } from "@taskboard/ui";
import { prettySize } from "../lib/chatEnvelope";
import { Modal } from "./Modal";

/**
 * "You dropped these — attach them?"
 *
 * Dropping a file into a chat used to SEND it: the drop handler went straight
 * down the same path as pressing Send, so a photo dragged onto the wrong window
 * was in someone else's conversation before the sender had seen it, with no
 * undo. Attachments are staged now, but a drop is still the one gesture a user
 * can perform entirely by accident — a file dragged towards a folder, released a
 * few pixels short — and unlike the paperclip or a paste it carries no
 * deliberate intent at all.
 *
 * So a drop asks. Nothing is uploaded until this is confirmed, which also means
 * cancelling costs nothing: the bytes never left the machine.
 *
 * Images preview at a size you can actually recognise. "Is this the right
 * screenshot" is the question this dialog exists to answer, and a 32px thumbnail
 * answers it no better than the filename does.
 */
export function DropConfirm({
  files,
  onConfirm,
  onCancel,
}: {
  /** The dropped files, or null when nothing is pending. */
  files: File[] | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("tasks");
  const previews = useObjectURLs(files);
  const count = files?.length ?? 0;

  return (
    <Modal
      open={count > 0}
      onClose={onCancel}
      title={t("dropConfirm.title", { count })}
    >
      <p className="mb-3 text-xs text-muted">
        {t("dropConfirm.description")}
      </p>

      <div className="max-h-64 space-y-1.5 overflow-auto">
        {(files ?? []).map((file, i) => (
          <div
            key={`${file.name}-${i}`}
            className="flex items-center gap-2.5 rounded-xl border border-border/60 p-2"
          >
            {previews[i] ? (
              <img
                src={previews[i]}
                alt=""
                className="h-14 w-14 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                <Paperclip size={16} className="text-muted" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{file.name}</span>
              <span className="block text-xs text-muted">{prettySize(file.size)}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {t("dropConfirm.cancel")}
        </Button>
        <Button size="sm" onClick={onConfirm}>
          <Upload size={14} /> {t("dropConfirm.attach")}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Object URLs for the image files in the list, revoked when the list changes.
 *
 * Without the revoke each cancelled drop would leak its blobs for the lifetime
 * of the document, which on a long-lived chat tab is the rest of the day.
 */
function useObjectURLs(files: File[] | null): (string | null)[] {
  const [urls, setUrls] = useState<(string | null)[]>([]);

  useEffect(() => {
    if (!files) {
      setUrls([]);
      return;
    }
    const made = files.map((f) => (f.type.startsWith("image/") ? URL.createObjectURL(f) : null));
    setUrls(made);
    return () => made.forEach((u) => u && URL.revokeObjectURL(u));
  }, [files]);

  return urls;
}
