/**
 * Recording a meeting onto the ORGANISER'S OWN DISK.
 *
 * ── Why this is not the server's egress ──────────────────────────────────────
 * LiveKit Egress records server-side: a headless browser joins the room, and
 * the finished file lands in the deployment's storage. That is a different
 * product decision from this one — here the recording never leaves the machine
 * of the person who asked for it, so there is no bucket, no retention policy
 * and nothing for an operator to hold. It also means recording needs no extra
 * infrastructure at all: everything below is browser-native.
 *
 * ── How the picture is made ──────────────────────────────────────────────────
 * The client is never sent a composited stream — it receives one track per
 * participant and arranges them itself. So to record what the meeting LOOKED
 * like, this draws the same grid onto a canvas, frame by frame, and records the
 * canvas. Audio is mixed separately through WebAudio, because a MediaStream can
 * only carry one audio track and a meeting has one per speaker.
 *
 * The tracks are the same MediaStreamTracks the tiles are already showing, so
 * this adds no subscriptions and no bandwidth — it re-draws what has already
 * arrived.
 */

import { downloadBlob } from "./download";

/** The canvas the grid is drawn onto. 720p: what the tiles carry, and what a
 *  laptop can encode in real time while also being in the meeting. */
const WIDTH = 1280;
const HEIGHT = 720;

/** Canvas frames per second handed to the encoder. The room's own video is
 *  rarely above 30, and every frame here costs the organiser's CPU twice —
 *  once compositing, once encoding — while they are also in the call. */
const FPS = 24;

/** ~2.5 Mbps at 720p. Comfortably above the point where a screen share of text
 *  stays readable, and an hour still fits in about a gigabyte. */
const VIDEO_BITS_PER_SECOND = 2_500_000;

/** How often the encoder hands over a chunk. Only affects how granular the
 *  in-memory buffer is; the file is assembled when recording stops. */
const CHUNK_MS = 1000;

/**
 * Container preferences, best first.
 *
 * VP8 leads deliberately: it encodes far cheaper than VP9 on a machine that is
 * simultaneously encoding a camera and decoding everyone else's, and this runs
 * on the organiser's laptop rather than on a server. MP4 is last because
 * MediaRecorder support for it is recent and not universal — WebM is what
 * Chromium has always been able to write.
 */
const MIME_CANDIDATES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "video/mp4",
];

/** One participant, as the compositor needs them. Deliberately not
 *  RoomParticipant: this module knows about pictures and sound, not about
 *  LiveKit or about who is in the call. */
export interface RecordingTile {
  /** Drawn under the tile, so a recording is still readable months later. */
  name: string;
  /** The picture to draw, or null when their camera is off. */
  video: MediaStreamTrack | null;
  audio: MediaStreamTrack | null;
  /** A shared screen is letterboxed; a camera is cropped to fill. Cropping a
   *  screen share cuts off exactly the content it was shared for. */
  letterbox: boolean;
}

/** Whether this browser can record at all. Checked before the button acts, so
 *  an unsupported browser says so instead of failing halfway through. */
export function canRecordLocally(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

function pickMimeType(): string | undefined {
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
}

/** A filename that says which meeting, and sorts. Matches the convention the
 *  chat and notes exports already use (callChat.ts, callNotes.ts). */
export function recordingFilename(title: string, ext: string, at = new Date()): string {
  const slug =
    (title || "meeting")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "meeting";
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
  return `${slug}-recording-${day}.${ext}`;
}

/** webm from "video/webm;codecs=…", mp4 from "video/mp4". */
export function extensionFor(mime: string): string {
  return mime.includes("mp4") ? "mp4" : "webm";
}

/**
 * A recording in progress.
 *
 * Built by `startLocalRecording`, ended by `stop()`. Everything it owns — the
 * hidden video elements, the AudioContext, the animation frame — is released in
 * `stop()`, including when the recorder errors, because these are camera and
 * audio resources on someone's laptop.
 */
export interface LocalRecording {
  /** Ends the recording and hands the file to the browser as a download.
   *  Resolves once the file has been assembled. Safe to call twice. */
  stop(): Promise<void>;
  /** Replaces the roster being drawn. Called as people join, leave, turn a
   *  camera on or start sharing — the grid follows the meeting. */
  update(tiles: RecordingTile[]): void;
}

/**
 * Start recording the grid to a file on this machine.
 *
 * `tiles()` is read fresh every frame rather than captured once: a meeting's
 * roster changes while it is being recorded, and a recording that froze on the
 * people who happened to be there at the start would be the wrong picture.
 */
export function startLocalRecording(options: {
  tiles: RecordingTile[];
  /** Names the file. */
  title: string;
  /** Surfaced to the caller; the recording is already over by then. */
  onError: (err: unknown) => void;
}): LocalRecording {
  const mimeType = pickMimeType();
  if (!canRecordLocally() || !mimeType) {
    throw new Error("This browser cannot record a meeting.");
  }

  let tiles = options.tiles;

  // ── The picture ────────────────────────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot record a meeting.");

  // Video elements must be in the document to decode reliably, so they live in
  // a hidden host rather than detached. Off-screen rather than display:none —
  // a display:none video is allowed to stop producing frames.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;";
  document.body.appendChild(host);

  /** One <video> per track id, reused across frames. Rebuilding them every
   *  frame would restart decoding and produce a black recording. */
  const videos = new Map<string, HTMLVideoElement>();

  const videoFor = (track: MediaStreamTrack): HTMLVideoElement => {
    const existing = videos.get(track.id);
    if (existing) return existing;
    const el = document.createElement("video");
    el.srcObject = new MediaStream([track]);
    el.autoplay = true;
    el.playsInline = true;
    // Load-bearing: these elements exist only to decode frames. Unmuted, every
    // participant would be heard twice — once from the room's own audio
    // elements and once from here.
    el.muted = true;
    host.appendChild(el);
    void el.play().catch(() => {
      /* A track that will not play draws as a name card; not fatal. */
    });
    videos.set(track.id, el);
    return el;
  };

  // ── The sound ──────────────────────────────────────────────────────────────
  const audioCtx = new AudioContext();
  const mixed = audioCtx.createMediaStreamDestination();
  /** One source node per track id. A MediaStreamTrack may only be connected
   *  once, so re-creating these on a roster change would throw. */
  const sources = new Map<string, MediaStreamAudioSourceNode>();

  const mixIn = (track: MediaStreamTrack) => {
    if (sources.has(track.id)) return;
    const node = audioCtx.createMediaStreamSource(new MediaStream([track]));
    // Into the recording only — never into audioCtx.destination, which would
    // play the whole meeting back through the organiser's speakers on top of
    // the audio elements already playing it.
    node.connect(mixed);
    sources.set(track.id, node);
  };

  // Autoplay policy can hand back a suspended context even inside a click.
  void audioCtx.resume().catch(() => {});

  // ── Drawing ────────────────────────────────────────────────────────────────
  let frame = 0;

  const draw = () => {
    frame = requestAnimationFrame(draw);
    ctx.fillStyle = "#0b0f19";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const shown = tiles.length ? tiles : [{ name: "", video: null, audio: null, letterbox: false }];
    const cols = Math.ceil(Math.sqrt(shown.length));
    const rows = Math.ceil(shown.length / cols);
    const cellW = WIDTH / cols;
    const cellH = HEIGHT / rows;

    shown.forEach((tile, i) => {
      const x = (i % cols) * cellW;
      const y = Math.floor(i / cols) * cellH;
      drawTile(ctx, tile, x, y, cellW, cellH, tile.video ? videoFor(tile.video) : null);
    });
  };
  frame = requestAnimationFrame(draw);

  // ── The encoder ────────────────────────────────────────────────────────────
  const stream = new MediaStream([
    ...canvas.captureStream(FPS).getVideoTracks(),
    ...mixed.stream.getAudioTracks(),
  ]);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => options.onError((e as ErrorEvent).error ?? e);

  /** Resolves when the encoder has flushed everything it holds. */
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => {
      if (chunks.length) {
        downloadBlob(
          new Blob(chunks, { type: mimeType }),
          recordingFilename(options.title, extensionFor(mimeType)),
        );
      }
      resolve();
    };
  });

  recorder.start(CHUNK_MS);

  const release = () => {
    cancelAnimationFrame(frame);
    sources.forEach((node) => node.disconnect());
    sources.clear();
    videos.forEach((el) => {
      el.srcObject = null;
    });
    videos.clear();
    host.remove();
    void audioCtx.close().catch(() => {});
  };

  let stopped = false;

  return {
    update(next) {
      tiles = next;
      next.forEach((t) => t.audio && mixIn(t.audio));
    },
    async stop() {
      if (stopped) return finished;
      stopped = true;
      if (recorder.state !== "inactive") recorder.stop();
      await finished;
      release();
    },
  };
}

/** Draws one participant into their cell: their picture if they have one, a
 *  name card if they do not, and their name either way. */
function drawTile(
  ctx: CanvasRenderingContext2D,
  tile: RecordingTile,
  x: number,
  y: number,
  w: number,
  h: number,
  video: HTMLVideoElement | null,
): void {
  const pad = 4;
  const [cx, cy, cw, ch] = [x + pad, y + pad, w - pad * 2, h - pad * 2];

  ctx.save();
  ctx.beginPath();
  ctx.rect(cx, cy, cw, ch);
  ctx.clip();

  ctx.fillStyle = "#161b26";
  ctx.fillRect(cx, cy, cw, ch);

  const ready = video && video.videoWidth > 0 && video.videoHeight > 0;
  if (ready && video) {
    const scale = tile.letterbox
      ? Math.min(cw / video.videoWidth, ch / video.videoHeight)
      : Math.max(cw / video.videoWidth, ch / video.videoHeight);
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    ctx.drawImage(video, cx + (cw - dw) / 2, cy + (ch - dh) / 2, dw, dh);
  } else if (tile.name) {
    // A name card, so a camera-off participant is still visibly present rather
    // than an unexplained empty cell.
    ctx.fillStyle = "#8b93a7";
    ctx.font = `${Math.round(Math.min(cw, ch) / 5)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(tile.name), cx + cw / 2, cy + ch / 2);
  }

  if (tile.name) {
    const size = Math.max(12, Math.round(ch / 22));
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const label = ctx.measureText(tile.name).width;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(cx, cy + ch - size * 2, label + size, size * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(tile.name, cx + size / 2, cy + ch - size * 0.6);
  }

  ctx.restore();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
