/**
 * Client-side thumbnail generation for image and video attachments.
 *
 * ── Why the client and not the server ────────────────────────────────────────
 * Go's stdlib `image` package decodes jpeg/png/gif and nothing else: no webp,
 * no avif, and crucially no heic — which is what every iPhone photo is. Video
 * posters would need ffmpeg shelled out from a read-only, capability-dropped,
 * memory-capped container. Both would also add an image-decoder attack surface
 * to a service that currently has none: a decompression-bomb PNG is a trivial
 * out-of-memory kill against that container.
 *
 * The browser already has hardware-accelerated decoders for everything it can
 * display, and it is decoding the user's own file on the user's own machine.
 *
 * ── Failure is always tolerable ──────────────────────────────────────────────
 * Every path returns null instead of throwing. A thumbnail is an optimisation:
 * without one, MediaBubble renders the full image (correct, just heavier) or a
 * poster-less <video> (the browser draws its own first frame). Nothing about
 * the send may depend on this succeeding.
 */

/** Longest edge of a generated poster. Small enough to upload instantly. */
const MAX_EDGE = 480;

/** webp at this quality is ~15 KB for a 480px poster and universally decodable. */
const THUMB_TYPE = "image/webp";
const THUMB_QUALITY = 0.72;

/** Give up rather than hang the composer on a file the browser won't decode. */
const VIDEO_TIMEOUT_MS = 5000;

export interface Thumbnail {
  blob: Blob;
  /** Natural dimensions of the SOURCE, not the poster — used to reserve layout space. */
  width: number;
  height: number;
  durationMs?: number;
}

/** Dimensions of the source, even when no poster could be produced. */
export interface Dimensions {
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface ThumbnailResult {
  thumb: Thumbnail | null;
  dimensions: Dimensions;
}

/**
 * Produces a poster and the source's natural dimensions, best-effort.
 *
 * Returns `{thumb: null, dimensions: {}}` for anything that is not an image or
 * video, or whenever generation fails for any reason at all.
 */
export async function makeThumbnail(file: Blob & { name?: string }): Promise<ThumbnailResult> {
  const none: ThumbnailResult = { thumb: null, dimensions: {} };
  try {
    // Bounded, because the CALLER AWAITS THIS BEFORE UPLOADING. A promise that
    // never settles here doesn't just skip the poster — it stops the send dead,
    // with no request, no error and no toast: the user picks a file and nothing
    // whatsoever happens. `createImageBitmap` and `canvas.toBlob` are both
    // capable of that on a malformed or enormous source (toBlob simply never
    // invokes its callback), so neither is allowed to run unbounded.
    if (file.type.startsWith("image/")) {
      return await withTimeout(imageThumbnail(file), THUMBNAIL_TIMEOUT_MS);
    }
    if (file.type.startsWith("video/")) {
      return await withTimeout(videoThumbnail(file), THUMBNAIL_TIMEOUT_MS);
    }
    return none;
  } catch {
    // Unsupported codec, tainted canvas, OffscreenCanvas unavailable, out of
    // memory on a huge source, or the timeout above — all of it degrades to
    // "no poster", and the upload proceeds regardless.
    return none;
  }
}

/**
 * Ceiling on poster generation. Generous enough for a large photo on a slow
 * machine, short enough that a stuck decoder is a brief pause rather than a
 * send that never happens.
 */
const THUMBNAIL_TIMEOUT_MS = 10_000;

async function imageThumbnail(file: Blob): Promise<ThumbnailResult> {
  if (typeof createImageBitmap !== "function") return { thumb: null, dimensions: {} };

  const bitmap = await createImageBitmap(file);
  const dimensions: Dimensions = { width: bitmap.width, height: bitmap.height };
  try {
    const blob = await draw(bitmap, bitmap.width, bitmap.height);
    return blob
      ? { thumb: { blob, width: bitmap.width, height: bitmap.height }, dimensions }
      : { thumb: null, dimensions };
  } finally {
    // Bitmaps hold decoded pixels; on a burst of large photos, not releasing
    // them is a real memory problem.
    bitmap.close?.();
  }
}

async function videoThumbnail(file: Blob): Promise<ThumbnailResult> {
  if (typeof document === "undefined") return { thumb: null, dimensions: {} };

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  // Required on iOS, where a video that wants fullscreen cannot be drawn from.
  video.playsInline = true;
  // Off-DOM but must not be display:none, or some engines skip decoding.
  video.style.position = "fixed";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";

  try {
    const meta = await withTimeout(
      new Promise<Dimensions>((resolve, reject) => {
        video.onloadedmetadata = () =>
          resolve({
            width: video.videoWidth || undefined,
            height: video.videoHeight || undefined,
            durationMs: Number.isFinite(video.duration)
              ? Math.round(video.duration * 1000)
              : undefined,
          });
        video.onerror = () => reject(new Error("video metadata failed"));
        video.src = url;
      }),
      VIDEO_TIMEOUT_MS,
    );

    // Frame 0 is very often a black fade-in, so seek slightly in — but never
    // past the midpoint, which would look wrong for a very short clip.
    const seekTo = Math.min(0.1, (video.duration || 0) / 2);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("video seek failed"));
        video.currentTime = seekTo;
      }),
      VIDEO_TIMEOUT_MS,
    );

    if (!video.videoWidth || !video.videoHeight) return { thumb: null, dimensions: meta };
    const blob = await draw(video, video.videoWidth, video.videoHeight);
    return blob
      ? {
          thumb: {
            blob,
            width: video.videoWidth,
            height: video.videoHeight,
            durationMs: meta.durationMs,
          },
          dimensions: meta,
        }
      : { thumb: null, dimensions: meta };
  } finally {
    video.onloadedmetadata = null;
    video.onseeked = null;
    video.onerror = null;
    // Detach the source before revoking so the element stops decoding.
    video.removeAttribute("src");
    video.load?.();
    URL.revokeObjectURL(url);
  }
}

/** Scales a drawable source down to MAX_EDGE and encodes it. */
async function draw(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
): Promise<Blob | null> {
  if (!srcW || !srcH) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    return canvas.convertToBlob({ type: THUMB_TYPE, quality: THUMB_QUALITY });
  }

  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), THUMB_TYPE, THUMB_QUALITY),
  );
}

/** A codec the browser half-supports can leave a promise pending forever. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
