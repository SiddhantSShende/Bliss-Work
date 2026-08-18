import { useCallback, useRef, useState } from "react";
import { Paperclip, X, Loader2, AlertCircle } from "lucide-react";
import type { AttachmentDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { errorText } from "../lib/errorText";

/** One file in the composer's tray, at whatever stage it has reached. */
export type MailAttachment = {
  /** Stable across the upload — the server id is not known until it finishes. */
  key: string;
  filename: string;
  sizeBytes: number;
  /** Percent 0–100 while uploading. */
  progress: number;
  /** Set once the upload lands; the id the mail is sent with. */
  id?: string;
  error?: string;
};

export type MailAttachmentsState = ReturnType<typeof useMailAttachments>;

/**
 * Attachment handling for the mail composer.
 *
 * Uploads go straight to the attachment endpoint under scope `mail`, scoped to
 * the DRAFT id — which is why the composer opens a draft on mount. Files land
 * on the server as the user picks them rather than at Send, so a 40 MB
 * attachment is already uploaded by the time they finish writing, and Send is a
 * small JSON request instead of a long silent wait.
 *
 * Uploaded blobs are expiring-by-default until the mail is sent (the server
 * clears their expiry as part of the send transaction), so a compose the user
 * abandons cannot leak files onto the volume.
 */
export function useMailAttachments(mailId: string | undefined) {
  const { api } = useRuntime();
  const [files, setFiles] = useState<MailAttachment[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const patch = useCallback((key: string, next: Partial<MailAttachment>) => {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...next } : f)));
  }, []);

  const upload = useCallback(
    async (file: File) => {
      if (!mailId) return;
      const key = `f${++seq.current}`;
      setFiles((prev) => [
        ...prev,
        { key, filename: file.name, sizeBytes: file.size, progress: 0 },
      ]);
      try {
        const dto: AttachmentDTO = await api.uploadAttachment("mail", mailId, file, {
          filename: file.name,
          onProgress: (loaded, total) =>
            patch(key, { progress: total > 0 ? Math.round((loaded / total) * 100) : 0 }),
        });
        patch(key, { id: dto.id, progress: 100 });
      } catch (e) {
        // Kept in the tray as a failed row rather than removed: a file that
        // vanishes silently is one the user believes they attached.
        patch(key, { error: errorText(e) });
        toast.error(`Could not attach ${file.name}`, { description: errorText(e) });
      }
    },
    [api, mailId, patch],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? []);
      // Reset so picking the SAME file twice still fires a change event.
      e.target.value = "";
      picked.forEach((f) => void upload(f));
    },
    [upload],
  );

  const remove = useCallback((key: string) => {
    // Only dropped from the tray. The blob keeps its 24h expiry and is reaped
    // server-side, because nothing outside the sent mail can reference it.
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }, []);

  return {
    files,
    /** True while any upload is in flight — Send waits for it. */
    isUploading: files.some((f) => !f.id && !f.error),
    pick: () => inputRef.current?.click(),
    remove,
    clear: () => setFiles([]),
    inputProps: {
      ref: inputRef,
      type: "file" as const,
      multiple: true,
      className: "hidden",
      onChange: onPick,
    },
  };
}

/** The composer's attachment tray. Renders nothing when there is nothing to show. */
export function MailAttachmentTray({
  files,
  remove,
}: Pick<MailAttachmentsState, "files" | "remove">) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-fg/80">
        Attachments ({files.length})
      </span>
      <ul className="flex flex-col gap-1">
        {files.map((f) => (
          <li
            key={f.key}
            className="flex items-center gap-2 rounded-xl border border-border bg-surface px-2.5 py-2 text-xs"
          >
            {f.error ? (
              <AlertCircle size={14} className="shrink-0 text-danger" />
            ) : f.id ? (
              <Paperclip size={14} className="shrink-0 text-muted" />
            ) : (
              <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-fg">{f.filename}</span>
              <span className={`block truncate ${f.error ? "text-danger" : "text-muted"}`}>
                {f.error ?? (f.id ? formatBytes(f.sizeBytes) : `Uploading… ${f.progress}%`)}
              </span>
            </span>
            <button
              type="button"
              onClick={() => remove(f.key)}
              aria-label={`Remove ${f.filename}`}
              className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-danger"
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

