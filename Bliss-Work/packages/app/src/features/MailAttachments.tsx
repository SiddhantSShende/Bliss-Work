import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Paperclip,
  X,
  Loader2,
  AlertCircle,
  Download,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  ImageIcon,
} from "lucide-react";
import type { AttachmentDTO, MailAttachmentDTO } from "@taskboard/shared";
import { useAttachmentLinks } from "../lib/useAttachmentLinks";
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
 * abandons cannot leak files onto the volume. Saving a draft pushes that expiry
 * out again, so a draft still being written keeps its files.
 *
 * @param initial files ALREADY on the draft, when one is being resumed from the
 *                Drafts folder. They have to be shown: Send commits every file
 *                scoped to the mail, so anything the tray does not list is a
 *                file the sender does not know they are about to send.
 */
export function useMailAttachments(mailId: string | undefined, initial?: MailAttachmentDTO[]) {
  const { api } = useRuntime();
  const [files, setFiles] = useState<MailAttachment[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  // Seeded once, when the resumed draft arrives. Keyed by the server id so a
  // re-render (or a refetch of the same draft) cannot duplicate a row.
  useEffect(() => {
    if (!initial?.length) return;
    setFiles((prev) => {
      const known = new Set(prev.map((f) => f.id).filter(Boolean));
      const seeded = initial
        .filter((a) => !known.has(a.id))
        .map((a) => ({
          key: `s${a.id}`,
          filename: a.filename,
          sizeBytes: a.sizeBytes,
          progress: 100,
          id: a.id,
        }));
      return seeded.length ? [...prev, ...seeded] : prev;
    });
  }, [initial]);

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

  const remove = useCallback(
    (key: string) => {
      // Read OUTSIDE the updater: a state updater must be pure, and one that
      // fires a request as a side effect sends it twice under StrictMode.
      const removedId = files.find((f) => f.key === key)?.id;
      setFiles((prev) => prev.filter((f) => f.key !== key));
      // A file that reached the server has to be taken off the DRAFT, not just
      // out of the tray: Send commits everything still scoped to the mail, so a
      // row left behind is a file the sender removed and sent anyway.
      if (mailId && removedId) {
        void api.removeDraftAttachment(mailId, removedId).catch((e) => {
          toast.error("Could not remove that file", { description: errorText(e) });
        });
      }
    },
    [api, files, mailId],
  );

  return {
    files,
    /** True while any upload is in flight — Send waits for it. */
    isUploading: files.some((f) => !f.id && !f.error),
    pick: () => inputRef.current?.click(),
    remove,
    /** Remove all — the same server-side detach as `remove`, once per file. */
    clear: () => {
      files.forEach((f) => remove(f.key));
    },
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

/**
 * A received mail's attachments, each behind a freshly minted signed link.
 *
 * The counterpart of the tray above: same file, other end of the send. It
 * mints its own links rather than taking them as a prop because the mint is
 * batched per rendered page and keyed on the ids — the one caller that has
 * those ids is this component.
 */
export function MailAttachmentCards({ attachments }: { attachments: MailAttachmentDTO[] }) {
  const ids = useMemo(() => attachments.map((a) => a.id), [attachments]);
  const links = useAttachmentLinks(ids);
  if (attachments.length === 0) return null;

  return (
    <section className="mt-6 border-t border-border/60 pt-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg/80">
        <Paperclip size={14} /> Attachments ({attachments.length})
      </h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {attachments.map((a) => {
          const url = links.urlFor(a.id);
          const { Icon, tone } = fileGlyph(a.mime, a.filename);
          return (
            <li
              key={a.id}
              className="flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2.5 text-xs transition-colors hover:border-accent/40"
            >
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
                <Icon size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-fg">{a.filename}</span>
                <span className="block truncate text-muted">{formatBytes(a.sizeBytes)}</span>
              </span>
              {url ? (
                <a
                  href={url}
                  download={a.filename}
                  title={`Download ${a.filename}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 font-medium text-accent hover:bg-accent-soft"
                >
                  <Download size={14} /> Download
                </a>
              ) : (
                // Links are minted in one batched, short-lived request; a
                // missing one means the mint is still in flight or access was
                // denied, and neither is a broken download button.
                <span className="shrink-0 text-muted">
                  {links.isLoading ? "Preparing…" : "Unavailable"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The glyph a file gets in the list.
 *
 * Type is read from the MIME the server stored, with the extension as the
 * fallback: inbound SMTP mail routinely arrives with application/octet-stream
 * on a perfectly ordinary .pdf.
 */
function fileGlyph(mime: string, filename: string): { Icon: typeof FileIcon; tone: string } {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext))
    return { Icon: ImageIcon, tone: "bg-accent-soft text-accent" };
  if (mime.includes("spreadsheet") || mime.includes("excel") || ["xlsx", "xls", "csv"].includes(ext))
    return { Icon: FileSpreadsheet, tone: "bg-success/12 text-success" };
  if (mime.includes("pdf") || ext === "pdf")
    return { Icon: FileText, tone: "bg-danger/12 text-danger" };
  return { Icon: FileIcon, tone: "bg-surface-2 text-muted" };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

