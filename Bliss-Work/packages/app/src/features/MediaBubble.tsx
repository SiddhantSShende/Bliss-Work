import { AlertCircle, FileIcon, Loader2, Play } from "lucide-react";
import { canPreviewDocInApp, prettySize, type MediaItem } from "../lib/chatEnvelope";

/**
 * Renders the attachments of one media message.
 *
 * ── Rendering is driven by the SERVER's mime, not the file extension ─────────
 * `item.mime` is what the server sniffed from the bytes at upload time. The
 * download endpoint independently refuses to serve anything script-capable
 * inline, so even a hostile envelope claiming `image/png` for an HTML file gets
 * `Content-Type: application/octet-stream` and downloads instead of executing.
 * The checks here decide layout; that endpoint is the security boundary.
 *
 * ── Every degradation is deliberate ─────────────────────────────────────────
 *   no thumbId        → render the full image (heavier, still correct), or a
 *                       poster-less <video> where the browser draws frame 1
 *   no signed URL yet → skeleton
 *   URL denied        → an explicit "unavailable" card, not a broken image icon
 */

export interface UploadProgress {
  /** 0–1, or undefined once the upload has finished. */
  ratio?: number;
  error?: string;
}

export function MediaBubble({
  items,
  mine,
  urlFor,
  isResolved,
  progress,
  onOpen,
}: {
  items: MediaItem[];
  mine: boolean;
  urlFor: (id: string | undefined) => string | undefined;
  isResolved: boolean;
  /** Keyed by item id while the message is still being sent. */
  progress?: Record<string, UploadProgress>;
  onOpen: (index: number) => void;
}) {
  const visuals = items.filter(
    (i) => i.mime.startsWith("image/") || i.mime.startsWith("video/"),
  );
  const others = items.filter((i) => !visuals.includes(i));

  // A single visual gets a large presentation; several become a square grid.
  const gridCols = visuals.length === 1 ? "grid-cols-1" : "grid-cols-2";

  return (
    <div className="flex w-[min(20rem,80vw)] flex-col gap-1.5">
      {visuals.length > 0 && (
        <div className={`grid gap-1 ${gridCols}`}>
          {visuals.map((item) => (
            <VisualTile
              key={item.id}
              item={item}
              single={visuals.length === 1}
              url={urlFor(item.thumbId) ?? urlFor(item.id)}
              isResolved={isResolved}
              progress={progress?.[item.id]}
              onOpen={() => onOpen(items.indexOf(item))}
            />
          ))}
        </div>
      )}

      {others.map((item) => (
        <FileCard
          key={item.id}
          item={item}
          mine={mine}
          url={urlFor(item.id)}
          isResolved={isResolved}
          progress={progress?.[item.id]}
          onOpen={() => onOpen(items.indexOf(item))}
        />
      ))}
    </div>
  );
}

function VisualTile({
  item,
  single,
  url,
  isResolved,
  progress,
  onOpen,
}: {
  item: MediaItem;
  single: boolean;
  url: string | undefined;
  isResolved: boolean;
  progress?: UploadProgress;
  onOpen: () => void;
}) {
  const isVideo = item.mime.startsWith("video/");
  // Reserve the right box before the image loads so the thread doesn't jump.
  // Falls back to 4:3 when the sender's client couldn't measure the source.
  const ratio = item.width && item.height ? item.width / item.height : 4 / 3;
  const style = single
    ? { aspectRatio: String(Math.min(Math.max(ratio, 0.6), 1.9)) }
    : { aspectRatio: "1" };

  if (progress?.error) return <ErrorTile style={style} message={progress.error} />;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${item.name}`}
      style={style}
      className="group relative w-full overflow-hidden rounded-xl bg-surface-2 ring-1 ring-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {url ? (
        <img
          src={url}
          alt={item.name}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
        />
      ) : isResolved ? (
        <Unavailable />
      ) : (
        <Skeleton />
      )}

      {isVideo && url && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Play size={20} fill="currentColor" />
          </span>
        </span>
      )}

      {isVideo && item.durationMs ? (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {formatDuration(item.durationMs)}
        </span>
      ) : null}

      {progress?.ratio !== undefined && <ProgressOverlay ratio={progress.ratio} />}
    </button>
  );
}

/**
 * A non-visual attachment (PDF, spreadsheet, archive, …) inside a message
 * bubble.
 *
 * Clicking it opens the file — never downloads it, matching the rest of the
 * app's "view, don't save" policy for chat attachments (see Lightbox's own
 * note, and internal/api/attachments.go's server-side enforcement, which
 * ignores `?dl=1`). Every resolved attachment is clickable, and always opens
 * the same in-app Lightbox the gallery uses, exactly like the identical
 * file's row in the conversation's "Media, Links & Docs" panel
 * (ChatAssetsSheet). A type the app can render itself (`canPreviewDocInApp`,
 * plus images/video) shows the file; anything else — Office documents,
 * archives — still opens the Lightbox, which explains it cannot be
 * previewed. There is no fallback to downloading: nothing here is ever a
 * link to the file, so a type outside the inline allowlist (media/mime.go)
 * simply has no bytes to leak through a click.
 */
function FileCard({
  item,
  mine,
  url,
  isResolved,
  progress,
  onOpen,
}: {
  item: MediaItem;
  mine: boolean;
  url: string | undefined;
  isResolved: boolean;
  progress?: UploadProgress;
  onOpen: () => void;
}) {
  const clickable = !progress && !!url;
  const previewable = canPreviewDocInApp(item.mime);
  const openable = clickable;

  const bubbleClass = `flex items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-left text-sm shadow-[0_2px_10px_-4px_rgba(40,30,90,0.25)] ${
    mine
      ? "rounded-br-md bg-gradient-to-br from-brand-from to-brand-to text-accent-fg"
      : "rounded-bl-md bg-surface text-fg ring-1 ring-border/60"
  } ${openable ? "transition-[filter] hover:brightness-95" : ""}`;

  const content = (
    <>
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
          mine ? "bg-accent-fg/15" : "bg-accent-soft text-accent"
        }`}
      >
        <FileIcon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{item.name}</div>
        <div className={`text-xs ${mine ? "text-accent-fg/70" : "text-muted"}`}>
          {progress?.error ? (
            <span className="text-danger">{progress.error}</span>
          ) : progress?.ratio !== undefined ? (
            `Uploading… ${Math.round(progress.ratio * 100)}%`
          ) : !url && isResolved ? (
            "Not available to you"
          ) : clickable && !previewable ? (
            "Preview isn't available for this file type"
          ) : (
            prettySize(item.size)
          )}
        </div>
        {progress?.ratio !== undefined && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-black/15">
            <div
              className="h-full rounded-full bg-current opacity-80"
              style={{ width: `${Math.round(progress.ratio * 100)}%`, transition: "width 120ms linear" }}
            />
          </div>
        )}
      </div>
      {!url && !isResolved ? (
        <Loader2 size={15} className="shrink-0 animate-spin opacity-60" />
      ) : null}
    </>
  );

  if (!openable) {
    return <div className={bubbleClass}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${item.name}`}
      className={`${bubbleClass} w-full`}
    >
      {content}
    </button>
  );
}

function Skeleton() {
  return <div className="h-full w-full animate-pulse bg-surface-2" />;
}

/**
 * Shown when the link mint completed but this attachment was not in the result
 * — i.e. the viewer may not read it. The usual cause is a forwarded media
 * message: the body is cloned verbatim, so it carries ids scoped to a
 * conversation the recipient is not a member of.
 */
function Unavailable() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-muted">
      <AlertCircle size={18} />
      <span className="text-[11px] leading-tight">Not available to you</span>
    </div>
  );
}

function ErrorTile({ style, message }: { style: React.CSSProperties; message: string }) {
  return (
    <div
      style={style}
      className="flex w-full flex-col items-center justify-center gap-1 rounded-xl bg-surface-2 p-2 text-center text-danger ring-1 ring-danger/30"
    >
      <AlertCircle size={18} />
      <span className="text-[11px] leading-tight">{message}</span>
    </div>
  );
}

function ProgressOverlay({ ratio }: { ratio: number }) {
  return (
    <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45">
      <Loader2 size={20} className="animate-spin text-white" />
      <span className="h-1 w-2/3 overflow-hidden rounded-full bg-white/25">
        <span
          className="block h-full rounded-full bg-white"
          style={{ width: `${Math.round(ratio * 100)}%`, transition: "width 120ms linear" }}
        />
      </span>
    </span>
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
