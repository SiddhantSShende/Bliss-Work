import { useCallback } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useRuntime } from "./runtime";
import { canShareFiles, handoffMediaFiles } from "./waMediaForward";

// Mirrors useAttachmentLinks.ts's MAX_LINK_BATCH: the server caps one
// /attachments/links mint at 50 ids (maxLinkBatch, attachments.go) and 400s
// the whole request otherwise. A media message forwarded to WhatsApp isn't
// bounded to that many items, so this call site needs the same chunking —
// unchunked, forwarding a big enough album would fail outright instead of
// just the items past the cap.
const MAX_LINK_BATCH = 50;

/**
 * Fires the media half of a WhatsApp forward, alongside (never instead of)
 * the existing text-only wa.me anchor click — see waMediaForward.ts for why
 * media can't travel through that link at all.
 *
 * This is intentionally NOT part of the anchor's own navigation: fetching the
 * attachment bytes is unavoidably async, so unlike forwardHref (a real
 * `<a href>` the browser navigates on its own — see MessageActions.tsx) this
 * cannot run before the click finishes without risking the wa.me popup being
 * blocked. The caller fires this as a SEPARATE, un-awaited call from the same
 * click handler, so the text hand-off is never delayed or put at risk by the
 * media one.
 */
export function useWhatsAppMediaForward() {
  const { api } = useRuntime();
  const { t } = useTranslation("chatThread");

  return useCallback(
    (attachments: Array<{ id: string; name: string; mime: string }>, caption?: string) => {
      if (attachments.length === 0) return;
      // Fire-and-forget from the caller's point of view: the click handler
      // that invokes this must not await it (see the file doc comment).
      void (async () => {
        let links;
        try {
          // Same authorized, short-lived, scope-rechecked link mint every
          // rendered attachment already goes through (useAttachmentLinks) —
          // no new authorization surface for external forwarding. Chunked
          // the same way, since this list isn't bounded to the server's
          // per-request cap the way a single rendered page usually is.
          const ids = attachments.map((a) => a.id);
          const chunks: string[][] = [];
          for (let index = 0; index < ids.length; index += MAX_LINK_BATCH) {
            chunks.push(ids.slice(index, index + MAX_LINK_BATCH));
          }
          const responses = await Promise.all(chunks.map((chunk) => api.attachmentLinks(chunk)));
          links = responses.flat();
        } catch {
          toast.error(t("whatsAppForward.mediaPrepareFailed"));
          return;
        }
        const byId = new Map(links.map((l) => [l.id, l] as const));
        const files: File[] = [];
        for (const a of attachments) {
          // Absent when the caller may not read this attachment (re-checked
          // server-side on every mint, same as useAttachmentLinks) — omitted
          // rather than failing the whole hand-off.
          const link = byId.get(a.id);
          if (!link) continue;
          try {
            const res = await fetch(api.mediaUrl(link.url));
            if (!res.ok) continue;
            files.push(new File([await res.blob()], a.name, { type: a.mime }));
          } catch {
            // One file failing to fetch should not sink the rest of the batch.
          }
        }
        if (files.length === 0) {
          toast.error(t("whatsAppForward.mediaPrepareFailed"), {
            description: t("whatsAppForward.mediaNoLongerAvailable"),
          });
          return;
        }

        const outcome = await handoffMediaFiles(files, { text: caption, download: downloadFile });
        switch (outcome.kind) {
          case "shared":
            toast.success(t("whatsAppForward.sharedToast"), {
              description: t("whatsAppForward.sharedDescription"),
            });
            break;
          case "share-cancelled":
            break; // The user closed the sheet without choosing anything — not an error.
          case "downloaded":
            toast(t("whatsAppForward.downloadedToast", { count: outcome.count }), {
              description: t("whatsAppForward.downloadedDescription"),
            });
            break;
          case "unsupported":
            break;
          case "error":
            toast.error(t("whatsAppForward.mediaShareFailed"), { description: outcome.message });
            break;
        }
      })();
    },
    [api, t],
  );
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
