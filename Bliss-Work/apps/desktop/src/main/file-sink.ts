import { app, ipcMain, shell, type BrowserWindow } from "electron";
import { createWriteStream, openSync, type WriteStream } from "node:fs";
import { statfs, unlink } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import { join } from "node:path";
import { sanitize } from "./attachment-open";

/**
 * Phase 10 disk-backed receiver sink. The renderer's WebRTC receiver streams
 * each chunk here over IPC; we append it to a file in the user's Downloads
 * folder so a multi-GB transfer never has to fit in renderer memory. On finish
 * the file is revealed in the OS file manager.
 *
 * Backpressure: `filesink:write` is an invoke (the renderer awaits it) and we
 * only resolve once the stream's write callback fires, so the receiver paces
 * itself to disk speed instead of buffering the whole file.
 */
interface Sink {
  stream: WriteStream;
  path: string;
  hash: Hash;
  lastActivity: number; // ms epoch — drives the abandoned-transfer reaper
  // The size negotiated at offer time (see fileTransfer.tsx's startReceive —
  // the SAME value backs both this and the receiver's own bound in
  // rtcTransfer.ts). filesink:write enforces this so a peer cannot stream
  // past what was ever agreed to, regardless of what the renderer forwards.
  size: number;
  bytesWritten: number;
  // First error the stream raised on its own (disk full, device gone, …).
  // Without a listener it would be an uncaughtException; kept so the next
  // write/finish reports it to the renderer instead.
  error?: Error;
}

const sinks = new Map<string, Sink>();
// Phase 10 sender-side streaming sha256: the renderer feeds the file in slices
// (constant memory) and we hash incrementally here, so a 10 GB sender never
// loads the whole file just to compute its digest.
const hashes = new Map<string, Hash>();
// Last-activity timestamps for in-progress sender hashes, so the reaper can drop
// a hash whose renderer died before calling hash:digest.
const hashTimes = new Map<string, number>();

// A transfer the renderer never finished (e.g. its process crashed mid-stream)
// would otherwise pin an open WriteStream + partial file forever. Reap anything
// idle longer than this.
const IDLE_SWEEP_MS = 60_000;
const IDLE_MAX_MS = 5 * 60_000;

// The size arrives from the renderer (a peer's offer), so it bounds what a peer
// may stream to disk and must not be taken at face value. 1 TiB is far past any
// real P2P transfer; the free-space check below is the tighter limit in practice.
export const MAX_SINK_BYTES = 1024 ** 4;

/** Free space in `dir` in bytes, or null when the platform cannot say. */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Create the file in the user's Downloads dir under the first free name
 * (name, "name (1)", …). The create is exclusive ("wx"), so a file that appears
 * between the check and the create is never overwritten — the next name is tried.
 * The open descriptor is returned so the stream writes to the file we made.
 */
function createUniqueFile(fileName: string): { path: string; fd: number } {
  const dir = app.getPath("downloads");
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  for (let n = 0; ; n++) {
    const path = join(dir, n === 0 ? fileName : `${stem} (${n})${ext}`);
    try {
      return { path, fd: openSync(path, "wx") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

export function registerFileSink(getMainWindow: () => BrowserWindow | null): void {
  // Same trust boundary as index.ts's fromMainWindow: every handler here
  // writes to disk and/or shells out, so only the main window's webContents
  // may drive them. Locally-scoped (rather than importing index.ts's private
  // helper) to avoid a circular dependency — see updater.ts/
  // window-state-guard.ts for the same getMainWindow-getter pattern.
  const fromMainWindow = (e: { sender: Electron.WebContents }): boolean =>
    e.sender === getMainWindow()?.webContents;

  ipcMain.handle(
    "filesink:open",
    async (e, { id, fileName, size }: { id: string; fileName: string; size: number }) => {
      if (!fromMainWindow(e)) return;
      // A malformed or absurd size (never a legitimate offer) is refused, and so
      // is one the disk cannot hold — otherwise a peer could "reserve" any amount
      // and then stream it into Downloads.
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SINK_BYTES) {
        throw new Error("filesink: invalid transfer size");
      }
      const free = await freeBytes(app.getPath("downloads"));
      if (free !== null && size > free) throw new Error("filesink: not enough free disk space");
      // A reused transfer id (e.g. a rapid double-open before the first call's
      // WriteStream was ever closed) must not orphan the earlier sink: its fd
      // would never close and its partial file would sit in Downloads forever
      // — invisible to both filesink:finish/abort (keyed by an id that now
      // points at the NEW sink) and the idle reaper (which only walks entries
      // still IN the map). Close it exactly as the reaper would before it is
      // replaced.
      const stale = sinks.get(id);
      if (stale) {
        stale.stream.destroy();
        void unlink(stale.path).catch(() => {});
      }
      // The negotiated size bounds filesink:write, so a peer offering a small
      // file cannot stream indefinitely past it (validated above).
      const { path, fd } = createUniqueFile(sanitize(fileName));
      const sink: Sink = {
        stream: createWriteStream(path, { fd }),
        path,
        hash: createHash("sha256"),
        lastActivity: Date.now(),
        size,
        bytesWritten: 0,
      };
      sink.stream.on("error", (err) => {
        sink.error = err;
        console.error("[filesink] stream error", id, err.message);
      });
      sinks.set(id, sink);
    },
  );

  ipcMain.handle("filesink:write", (e, { id, data }: { id: string; data: ArrayBuffer }) => {
    if (!fromMainWindow(e)) return;
    const s = sinks.get(id);
    if (!s) return;
    if (s.error) throw s.error;
    const buf = Buffer.from(data);
    // The size cap this handler exists to enforce: reject outright rather
    // than truncate-and-accept, which would leave a corrupted file that
    // still passes as "received" to the caller.
    if (s.bytesWritten + buf.length > s.size) {
      throw new Error("filesink: write would exceed the transfer's negotiated size");
    }
    s.lastActivity = Date.now();
    s.hash.update(buf); // incremental integrity hash (constant memory)
    return new Promise<void>((resolve, reject) => {
      s.stream.write(buf, (err) => {
        if (err) {
          reject(err);
          return;
        }
        s.bytesWritten += buf.length;
        resolve();
      });
    });
  });

  // Returns true if the received bytes' sha256 matched (file kept + revealed),
  // false on mismatch (the corrupt file is deleted).
  ipcMain.handle(
    "filesink:finish",
    (e, { id, expectedSha256 }: { id: string; expectedSha256: string }) => {
      if (!fromMainWindow(e)) return false;
      const s = sinks.get(id);
      if (!s) return false;
      sinks.delete(id);
      return new Promise<boolean>((resolve) => {
        s.stream.end(async (err?: Error | null) => {
          if (err || s.error) {
            await unlink(s.path).catch(() => {});
            resolve(false);
          } else if (s.hash.digest("hex") === expectedSha256) {
            shell.showItemInFolder(s.path);
            resolve(true);
          } else {
            await unlink(s.path).catch(() => {});
            resolve(false);
          }
        });
      });
    },
  );

  ipcMain.on("filesink:abort", (e, { id }: { id: string }) => {
    if (!fromMainWindow(e)) return;
    const s = sinks.get(id);
    if (s) {
      s.stream.destroy();
      sinks.delete(id);
      // Matches finish's mismatch branch and the reaper: an aborted transfer
      // is exactly as unrecoverable as a corrupt or abandoned one, so its
      // partial file must not be the one cleanup path that leaves it behind.
      void unlink(s.path).catch(() => {});
    }
  });

  // ── sender-side streaming sha256 ────────────────────────────────────────────
  ipcMain.handle("hash:update", (e, { id, data }: { id: string; data: ArrayBuffer }) => {
    if (!fromMainWindow(e)) return;
    let h = hashes.get(id);
    if (!h) {
      h = createHash("sha256");
      hashes.set(id, h);
    }
    hashTimes.set(id, Date.now());
    h.update(Buffer.from(data));
  });

  ipcMain.handle("hash:digest", (e, { id }: { id: string }) => {
    if (!fromMainWindow(e)) return "";
    const h = hashes.get(id);
    hashes.delete(id);
    hashTimes.delete(id);
    return h ? h.digest("hex") : "";
  });

  // Reaper: drop transfers/hashes whose renderer died mid-stream so a crashed
  // peer can't leak open file handles + partial files. unref() so it never keeps
  // the process alive on its own.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sinks) {
      if (now - s.lastActivity > IDLE_MAX_MS) {
        s.stream.destroy();
        void unlink(s.path).catch(() => {});
        sinks.delete(id);
        console.warn("[filesink] reaped abandoned transfer", id);
      }
    }
    for (const [id, t] of hashTimes) {
      if (now - t > IDLE_MAX_MS) {
        hashes.delete(id);
        hashTimes.delete(id);
      }
    }
  }, IDLE_SWEEP_MS);
  sweeper.unref();
}
