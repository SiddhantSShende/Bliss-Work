import { Check, FileIcon, Loader2, X } from "lucide-react";
import type { TransferState } from "../lib/rtcTransfer";

/**
 * Visual for a single file attachment offer inside a thread bubble.
 *
 * Four discrete states cover the user-facing lifecycle:
 *   OFFERED       — receiver sees Accept / Decline; sender sees "Sent — waiting"
 *   TRANSFERRING  — progress bar driven by the rtc transfer state machine
 *   DONE          — Open / Reveal-in-folder buttons (Open is wired by the host)
 *   FAILED        — inline error with optional Retry (sender) / Try again later
 *
 * Reused by the thread renderer + the legacy ChatThread once Phase 10 is on.
 */
export interface FileAttachmentBubbleProps {
  mine: boolean;
  fileName: string;
  fileSize: number;
  state: TransferState;
  onAccept?: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
  onOpen?: () => void;
  onRetry?: () => void;
}

export function FileAttachmentBubble(props: FileAttachmentBubbleProps) {
  const { mine, fileName, fileSize, state } = props;

  return (
    <div
      className={`flex w-[80%] flex-col gap-2 rounded-2xl px-3.5 py-2.5 text-sm shadow-[0_2px_10px_-4px_rgba(40,30,90,0.25)] ${
        mine
          ? "rounded-br-md bg-gradient-to-br from-brand-from to-brand-to text-accent-fg"
          : "rounded-bl-md bg-surface text-fg ring-1 ring-border/60"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${mine ? "bg-white/15" : "bg-accent-soft text-accent"}`}>
          <FileIcon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{fileName}</div>
          <div className={`text-xs ${mine ? "text-white/70" : "text-muted"}`}>{formatSize(fileSize)}</div>
        </div>
        {state.kind === "DONE" && (
          <Check size={16} className={mine ? "text-white" : "text-success"} />
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
            <span className="text-xs opacity-70">File downloads are turned off.</span>
            <Btn variant="ghost" onClick={props.onDecline}>Decline</Btn>
          </>
        )}
        {state.kind === "OFFERED" && mine && (
          <Btn variant="ghost" onClick={props.onCancel}>Cancel</Btn>
        )}
        {state.kind === "TRANSFERRING" && (
          <Btn variant="ghost" onClick={props.onCancel}>Cancel</Btn>
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
              <Btn variant="ghost" onClick={props.onRetry}>Retry</Btn>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StateLine({ state }: { state: TransferState }) {
  if (state.kind === "OFFERED") {
    return <div className="text-xs opacity-70">Direct transfer — peer-to-peer.</div>;
  }
  if (state.kind === "CONNECTING") {
    return (
      <div className="flex items-center gap-1 text-xs opacity-70">
        <Loader2 size={12} className="animate-spin" /> Establishing peer connection…
      </div>
    );
  }
  if (state.kind === "TRANSFERRING") {
    const pct = Math.min(100, Math.floor((state.progress.bytesDone / state.progress.bytesTotal) * 100));
    return (
      <div className="space-y-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/15">
          <div
            className="h-full rounded-full bg-current opacity-80"
            style={{ width: `${pct}%`, transition: "width 80ms linear" }}
          />
        </div>
        <div className="flex justify-between text-[10px] opacity-70">
          <span>{formatSize(state.progress.bytesDone)} / {formatSize(state.progress.bytesTotal)}</span>
          <span>{pct}%</span>
        </div>
      </div>
    );
  }
  if (state.kind === "DONE") {
    return <div className="text-xs opacity-80">Transfer complete.</div>;
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
