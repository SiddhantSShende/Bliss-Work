import { app, ipcMain, shell } from "electron";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import { join } from "node:path";

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

/** Strip path separators / leading dots from a peer-supplied filename. */
function sanitize(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/^\.+/, "").trim();
  return base || "download";
}

/** A non-colliding path in the user's Downloads dir (name, "name (1)", …). */
function uniquePath(fileName: string): string {
  const dir = app.getPath("downloads");
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let candidate = join(dir, fileName);
  let n = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

export function registerFileSink(): void {
  ipcMain.handle("filesink:open", (_e, { id, fileName }: { id: string; fileName: string }) => {
    const path = uniquePath(sanitize(fileName));
    sinks.set(id, { stream: createWriteStream(path), path, hash: createHash("sha256"), lastActivity: Date.now() });
  });

  ipcMain.handle("filesink:write", (_e, { id, data }: { id: string; data: ArrayBuffer }) => {
    const s = sinks.get(id);
    if (!s) return;
    s.lastActivity = Date.now();
    const buf = Buffer.from(data);
    s.hash.update(buf); // incremental integrity hash (constant memory)
    return new Promise<void>((resolve, reject) => {
      s.stream.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  });

  // Returns true if the received bytes' sha256 matched (file kept + revealed),
  // false on mismatch (the corrupt file is deleted).
  ipcMain.handle(
    "filesink:finish",
    (_e, { id, expectedSha256 }: { id: string; expectedSha256: string }) => {
      const s = sinks.get(id);
      if (!s) return false;
      sinks.delete(id);
      return new Promise<boolean>((resolve) => {
        s.stream.end(async () => {
          if (s.hash.digest("hex") === expectedSha256) {
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

  ipcMain.on("filesink:abort", (_e, { id }: { id: string }) => {
    const s = sinks.get(id);
    if (s) {
      s.stream.destroy();
      sinks.delete(id);
    }
  });

  // ── sender-side streaming sha256 ────────────────────────────────────────────
  ipcMain.handle("hash:update", (_e, { id, data }: { id: string; data: ArrayBuffer }) => {
    let h = hashes.get(id);
    if (!h) {
      h = createHash("sha256");
      hashes.set(id, h);
    }
    hashTimes.set(id, Date.now());
    h.update(Buffer.from(data));
  });

  ipcMain.handle("hash:digest", (_e, { id }: { id: string }) => {
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
