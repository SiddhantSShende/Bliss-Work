import { Check, FileIcon, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { prettySize } from "../lib/fileOffer";
import type { TransferState } from "../lib/rtcTransfer";

/**
 * Visual for a single file attachment offer inside a thread bubble.
 *
 * Four discrete states cover the user-facing lifecycle:
 *   OFFERED       — receiver sees "downloads are off" + Decline; sender sees
 *                   "Sent — waiting" (no Accept — see the note below)
 *   TRANSFERRING  — progress bar driven by the rtc transfer state machine
 *   DONE          — just the completion line; no handle back to the bytes
 *   FAILED        — inline error with optional Retry (sender) / Try again later
 *
 * Reused by the thread renderer + the legacy ChatThread once Phase 10 is on.
 */
interface FileAttachmentBubbleProps {
  mine: boolean;
  fileName: string;
  fileSize: number;
  state: TransferState;
  onDecline?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
}

export function FileAttachmentBubble(props: FileAttachmentBubbleProps) {
  const { t } = useTranslation("chatMedia");
  const { mine, fileName, fileSize, state } = props;

  return (
    <div
      className={`flex w-[80%] flex-col gap-2 rounded-2xl px-3.5 py-2.5 text-sm shadow-[0_2px_10px_-4px_rgba(40,30,90,0.25)] ${
        mine
          ? "rounded-br-md bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg"
          : "rounded-bl-md bg-surface text-fg ring-1 ring-border/60"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${mine ? "bg-accent-fg/15" : "bg-accent-soft text-accent"}`}>
          <FileIcon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{fileName}</div>
          <div className={`text-xs ${mine ? "text-accent-fg/70" : "text-muted"}`}>{prettySize(fileSize)}</div>
        </div>
        {state.kind === "DONE" && (
          <Check size={16} className={mine ? "text-accent-fg" : "text-success"} />
        )}
      </div>

      <StateLine state={state} />

      <div className="mt-1 flex flex-wrap gap-1.5">
        {/* Accept is gone: this transfer writes the file to the recipient's
            disk, which is exactly what downloading attachments is no longer
            allowed to do. Decline stays so the offer can still be cleared
            instead of sitting in the thread forever. */}
        {state.kind === "OFFERED" && !mine && (
          <>
            <span className="text-xs opacity-70">{t("fileAttachment.downloadsOff")}</span>
            <Btn variant="ghost" onClick={props.onDecline}>{t("fileAttachment.decline")}</Btn>
          </>
        )}
        {state.kind === "OFFERED" && mine && (
          <Btn variant="ghost" onClick={props.onCancel}>{t("fileAttachment.cancel")}</Btn>
        )}
        {state.kind === "TRANSFERRING" && (
          <Btn variant="ghost" onClick={props.onCancel}>{t("fileAttachment.cancel")}</Btn>
        )}
        {/* "Open" reveals the received file on disk — same reason as Accept.
            Historic DONE transfers keep their completion line, without the
            handle back to the file. */}
        {state.kind === "FAILED" && (
          <>
            <span className="inline-flex items-center gap-1 text-xs text-danger">
              <X size={12} /> {state.reason}
            </span>
            {mine && props.onRetry && (
              <Btn variant="ghost" onClick={props.onRetry}>{t("fileAttachment.retry")}</Btn>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StateLine({ state }: { state: TransferState }) {
  const { t } = useTranslation("chatMedia");
  if (state.kind === "OFFERED") {
    return <div className="text-xs opacity-70">{t("fileAttachment.directTransfer")}</div>;
  }
  if (state.kind === "CONNECTING") {
    return (
      <div className="flex items-center gap-1 text-xs opacity-70">
        <Loader2 size={12} className="animate-spin" /> {t("fileAttachment.establishingConnection")}
      </div>
    );
  }
  if (state.kind === "TRANSFERRING") {
    // A 0-byte file has nothing to transfer — bytesTotal === 0 would divide
    // to NaN and render "NaN%" with an invalid `width: NaN%` bar. Treat it as
    // fully transferred instead of computing a ratio.
    const pct =
      state.progress.bytesTotal === 0
        ? 100
        : Math.min(100, Math.floor((state.progress.bytesDone / state.progress.bytesTotal) * 100));
    return (
      <div className="space-y-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/15">
          <div
            className="h-full rounded-full bg-current opacity-80"
            style={{ width: `${pct}%`, transition: "width 80ms linear" }}
          />
        </div>
        <div className="flex justify-between text-[10px] opacity-70">
          <span>{prettySize(state.progress.bytesDone)} / {prettySize(state.progress.bytesTotal)}</span>
          <span>{pct}%</span>
        </div>
      </div>
    );
  }
  if (state.kind === "DONE") {
    return <div className="text-xs opacity-80">{t("fileAttachment.transferComplete")}</div>;
  }
  return null;
}

function Btn({
  children,
  onClick,
  variant,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant: "accent" | "ghost";
}) {
  const cls =
    variant === "accent"
      ? "bg-white text-accent hover:bg-white/90"
      : "border border-current text-current hover:bg-white/10";
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors ${cls}`}
    >
      {children}
    </button>
  );
}
