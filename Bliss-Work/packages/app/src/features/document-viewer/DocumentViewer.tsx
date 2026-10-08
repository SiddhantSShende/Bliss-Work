import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2, X } from "lucide-react";
import type { MediaItem } from "../../lib/chatEnvelope";
import { prettySize } from "../../lib/chatEnvelope";
import type { DocumentMode } from "../../lib/attachmentCapability";
import { PdfFrame } from "./PdfFrame";
import { SheetGrid } from "./SheetGrid";
import { useDocumentPreview, type PreviewFailure } from "./useDocumentPreview";

/**
 * The in-app viewer for Word, PowerPoint and Excel files, CSV and .txt files that
 * the existing preview cannot carry. READ-ONLY.
 *
 * Office files are converted in the Office Document Sandbox (server side); this
 * shows what comes back — a PDF, or the cell text of a spreadsheet — and never
 * opens an Office file itself. When a document cannot be previewed it says so and,
 * if the surface passed `onDownload`, offers Download through that surface's own
 * audited download path.
 *
 * Its own overlay, matching Lightbox's chrome (Escape closes, focus returns to
 * the opener, `aria-modal`), and deliberately without a download button of its
 * own — like the Lightbox, one audited download path per surface.
 */
export function DocumentViewer({
  item,
  url,
  mode,
  onClose,
  onDownload,
}: {
  item: MediaItem;
  url: string | undefined;
  mode: DocumentMode;
  onClose: () => void;
  onDownload?: (item: MediaItem) => void;
}) {
  const { t } = useTranslation("common");
  const preview = useDocumentPreview(url, mode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      className="fixed inset-x-0 bottom-0 top-[var(--titlebar-inset,0px)] z-[100] flex flex-col bg-black/95 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{item.name}</div>
          <div className="text-xs text-white/60">{prettySize(item.size)}</div>
        </div>
        <button
          onClick={onClose}
          title={t("lightbox.close")}
          aria-label={t("lightbox.close")}
          className="shrink-0 rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white"
        >
          <X size={18} />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {preview.status === "loading" && (
          <div className="flex flex-col items-center gap-2 text-center text-sm text-white/70" role="status">
            <Loader2 size={20} className="animate-spin" />
            <span>{preview.converting ? t("documentViewer.converting") : t("lightbox.loadingPreview")}</span>
          </div>
        )}
        {preview.status === "error" && <FailurePanel reason={preview.reason} onDownload={onDownload && (() => onDownload(item))} />}
        {preview.status === "ready" && preview.kind === "pdf" && <PdfFrame url={preview.pdfUrl} name={item.name} />}
        {preview.status === "ready" && preview.kind === "grid" && (
          <SheetGrid sheets={preview.preview.sheets} moreSheets={preview.preview.moreSheets} fromCsv={preview.fromCsv} />
        )}
        {preview.status === "ready" && preview.kind === "text" && <TextPanel text={preview.text} truncated={preview.truncated} />}
      </div>
    </div>
  );
}

const REASON_KEY: Record<PreviewFailure, string> = {
  failed: "documentViewer.failed",
  unavailable: "documentViewer.unavailable",
  busy: "documentViewer.busy",
  tooLarge: "documentViewer.tooLarge",
  timedOut: "documentViewer.timedOut",
  network: "documentViewer.network",
};

/** Always ends in the Download fallback (when the surface provides one). */
function FailurePanel({ reason, onDownload }: { reason: PreviewFailure; onDownload?: () => void }) {
  const { t } = useTranslation("common");
  return (
    <div
      role="alert"
      className="flex max-w-xs flex-col items-center gap-2 text-center text-sm text-white/70"
      onClick={(e) => e.stopPropagation()}
    >
      <AlertCircle size={24} className="text-white/60" />
      <span className="text-white/90">{t(REASON_KEY[reason])}</span>
      {onDownload && (
        <>
          <span>{t("documentViewer.failedHint")}</span>
          <button
            type="button"
            onClick={onDownload}
            className="mt-1 rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
          >
            {t("documentViewer.download")}
          </button>
        </>
      )}
    </div>
  );
}

function TextPanel({ text, truncated }: { text: string; truncated: boolean }) {
  const { t } = useTranslation("common");
  return (
    <div
      className="flex h-full max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-surface text-fg"
      onClick={(e) => e.stopPropagation()}
    >
      {text === "" ? (
        <p className="p-6 text-center text-sm text-muted">{t("documentViewer.emptyFile")}</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-xs">{text}</pre>
      )}
      {truncated && <p className="border-t border-border px-3 py-2 text-xs text-muted">{t("documentViewer.textTruncated")}</p>}
    </div>
  );
}
