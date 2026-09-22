import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Paperclip,
  X,
  Loader2,
  AlertCircle,
  ExternalLink,
  Eye,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  ImageIcon,
} from "lucide-react";
import type { AttachmentDTO, MailAttachmentDTO } from "@taskboard/shared";
import { useTranslation } from "react-i18next";
import { useAttachmentLinks } from "../lib/useAttachmentLinks";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { errorText } from "../lib/errorText";
import { openAttachmentNatively, rendersInApp } from "../lib/openAttachment";
import { MEDIA_MAX_BYTES, type MediaItem } from "../lib/chatEnvelope";
import { prettySize } from "../lib/fileOffer";
import { Lightbox } from "./Lightbox";

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
  const { t } = useTranslation("mail");
  const { api } = useRuntime();
  const [files, setFiles] = useState<MailAttachment[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  // One AbortController per upload still in flight, so remove() can actually
  // cancel it instead of letting it finish and stay attached server-side
  // after the row it belonged to has already vanished from the tray.
  const controllers = useRef(new Map<string, AbortController>());
  // Keys whose server-side detach (removeDraftAttachment) has not resolved
  // yet. Send has to wait on this the same way it waits on isUploading —
  // otherwise a detach racing a Send can lose, and the file the user just
  // removed from the tray ships anyway.
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
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
      const controller = new AbortController();
      controllers.current.set(key, controller);
      setFiles((prev) => [
        ...prev,
        { key, filename: file.name, sizeBytes: file.size, progress: 0 },
      ]);
      let dto: AttachmentDTO;
      try {
        dto = await api.uploadAttachment("mail", mailId, file, {
          filename: file.name,
          onProgress: (loaded, total) =>
            patch(key, { progress: total > 0 ? Math.round((loaded / total) * 100) : 0 }),
          signal: controller.signal,
        });
      } catch (e) {
        controllers.current.delete(key);
        // remove() aborted this upload — the row is already gone from the
        // tray, so there is nothing left to show an error on.
        if (controller.signal.aborted) return;
        // Kept in the tray as a failed row rather than removed: a file that
        // vanishes silently is one the user believes they attached.
        patch(key, { error: errorText(e) });
        toast.error(t("attachments.couldNotAttachToast", { filename: file.name }), {
          description: errorText(e),
        });
        return;
      }
      controllers.current.delete(key);
      if (controller.signal.aborted) {
        // remove() fired after the upload had already reached the server —
        // xhr.abort() lost that race, so the file is sitting on the draft
        // with nobody in the tray to name it. Detach it now, the same way
        // remove() would have, instead of letting it ship silently.
        void api.removeDraftAttachment(mailId, dto.id).catch(() => {});
        return;
      }
      patch(key, { id: dto.id, progress: 100 });
    },
    [api, mailId, patch],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? []);
      // Reset so picking the SAME file twice still fires a change event.
      e.target.value = "";
      for (const file of picked) {
        // Same server-enforced cap chat attachments pre-check against
        // (MEDIA_MAX_BYTES) — mail has no peer-to-peer fallback, so an
        // oversized file simply cannot be attached rather than starting an
        // upload the server will refuse.
        if (file.size > MEDIA_MAX_BYTES) {
          toast.error(t("attachments.tooLargeToast", { filename: file.name, maxSize: prettySize(MEDIA_MAX_BYTES) }));
          continue;
        }
        void upload(file);
      }
    },
    [upload],
  );

  const remove = useCallback(
    (key: string) => {
      // Read OUTSIDE the updater: a state updater must be pure, and one that
      // fires a request as a side effect sends it twice under StrictMode.
      const removedId = files.find((f) => f.key === key)?.id;
      // Still uploading: cancel it rather than let it finish and stay
      // attached server-side after its row is gone from the tray.
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      setFiles((prev) => prev.filter((f) => f.key !== key));
      // A file that reached the server has to be taken off the DRAFT, not just
      // out of the tray: Send commits everything still scoped to the mail, so a
      // row left behind is a file the sender removed and sent anyway.
      if (mailId && removedId) {
        setPendingRemovals((prev) => new Set(prev).add(key));
        void api
          .removeDraftAttachment(mailId, removedId)
          .catch((e) => {
            toast.error(t("attachments.couldNotRemoveToast"), { description: errorText(e) });
          })
          .finally(() => {
            setPendingRemovals((prev) => {
              if (!prev.has(key)) return prev;
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
          });
      }
    },
    [api, files, mailId],
  );

  return {
    files,
    /** True while any upload is in flight — Send waits for it. */
    isUploading: files.some((f) => !f.id && !f.error),
    /** True while a removed file's server-side detach hasn't resolved yet —
     *  Send waits for this too, so a removed attachment can't win a race
     *  against Send and go out anyway. */
    isRemoving: pendingRemovals.size > 0,
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
  const { t } = useTranslation("mail");
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-fg/80">
        {t("attachments.heading", { count: files.length })}
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
                {f.error ?? (f.id ? formatBytes(f.sizeBytes) : t("attachments.tray.uploading", { progress: f.progress }))}
              </span>
            </span>
            <button
              type="button"
              onClick={() => remove(f.key)}
              aria-label={t("attachments.tray.remove", { filename: f.filename })}
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

/** MailAttachmentDTO, reshaped for the same Lightbox chat attachments preview
 *  in — Lightbox only needs the fields it actually renders. */
function toMediaItem(a: MailAttachmentDTO): MediaItem {
  return { id: a.id, name: a.filename, size: a.sizeBytes, mime: a.mime };
}

/**
 * A received mail's attachments, each behind a freshly minted signed link.
 *
 * The counterpart of the tray above: same file, other end of the send. It
 * mints its own links rather than taking them as a prop because the mint is
 * batched per rendered page and keyed on the ids — the one caller that has
 * those ids is this component.
 *
 * A type the app can render itself (image, video, PDF, plain text — see
 * `canPreviewDocInApp`) opens in-app, in the SAME Lightbox the chat
 * attachments use. Everything else opens via `target="_blank"`, never a
 * same-tab `download`-attributed link: Electron's `will-navigate` guard
 * (apps/desktop/src/main/harden.ts) fires for those too and — because a
 * signed attachment URL is never "our own content" — cancels the navigation
 * outright, so the click did nothing at all. `target="_blank"` instead goes
 * through `setWindowOpenHandler`, which is what reliably hands the URL to
 * `shell.openExternal` (or, on web, just opens a new tab) — the same path
 * ChatAssetsSheet's doc links already use.
 *
 * On desktop specifically, `config.openAttachment` (present only in
 * Electron — see platform.ts) is used instead: it fetches the file in main
 * and opens it with the OS's native default app, so the click lands on the
 * file itself rather than on the system browser. Web has no such capability
 * and keeps the `target="_blank"` anchor exactly as before.
 */
export function MailAttachmentCards({ attachments }: { attachments: MailAttachmentDTO[] }) {
  const { t } = useTranslation("mail");
  const { config } = useRuntime();
  const ids = useMemo(() => attachments.map((a) => a.id), [attachments]);
  const links = useAttachmentLinks(ids);
  const [preview, setPreview] = useState<MailAttachmentDTO | null>(null);
  if (attachments.length === 0) return null;

  const openNatively = (filename: string, url: string) => openAttachmentNatively(config, url, filename);

  return (
    <section className="mt-6 border-t border-border/60 pt-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg/80">
        <Paperclip size={14} /> {t("attachments.heading", { count: attachments.length })}
      </h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {attachments.map((a) => {
          const url = links.urlFor(a.id);
          const { Icon, tone } = fileGlyph(a.mime, a.filename);
          const previewable = !!url && rendersInApp(a.mime);
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
              {previewable ? (
                <button
                  type="button"
                  onClick={() => setPreview(a)}
                  title={t("attachments.previewFile", { filename: a.filename })}
                  aria-label={t("attachments.previewFile", { filename: a.filename })}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 font-medium text-accent hover:bg-accent-soft"
                >
                  <Eye size={14} /> {t("attachments.preview")}
                </button>
              ) : url && config.openAttachment ? (
                <button
                  type="button"
                  onClick={() => void openNatively(a.filename, url)}
                  title={t("attachments.openFile", { filename: a.filename })}
                  aria-label={t("attachments.openFile", { filename: a.filename })}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 font-medium text-accent hover:bg-accent-soft"
                >
                  <ExternalLink size={14} /> {t("attachments.open")}
                </button>
              ) : url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t("attachments.openFile", { filename: a.filename })}
                  aria-label={t("attachments.openFile", { filename: a.filename })}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 font-medium text-accent hover:bg-accent-soft"
                >
                  <ExternalLink size={14} /> {t("attachments.open")}
                </a>
              ) : (
                // Links are minted in one batched, short-lived request; a
                // missing one means the mint is still in flight or access was
                // denied, and neither is a broken download button.
                <span className="shrink-0 text-muted">
                  {links.isLoading ? t("attachments.preparing") : t("attachments.unavailable")}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {preview && (
        <Lightbox
          items={[toMediaItem(preview)]}
          index={0}
          urlFor={links.urlFor}
          onClose={() => setPreview(null)}
          onIndexChange={() => {}}
        />
      )}
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

