import { app, ipcMain, shell, type BrowserWindow } from "electron";
import { createWriteStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safeExternalUrl } from "../shared/external-url";

/**
 * Desktop-native counterpart of MailAttachmentCards' non-previewable
 * "Download" link. That link is `target="_blank"` on purpose (a same-tab
 * `download`-attributed link is killed outright by harden.ts's
 * `will-navigate` guard, since a signed attachment URL is never "our own
 * content") — but on desktop that routes through `setWindowOpenHandler` into
 * `shell.openExternal`, handing the URL to the OS's default BROWSER. This
 * gives desktop a better outcome: fetch the file here in main, land it in
 * Downloads, then hand the FILE ITSELF to the OS's native default app via
 * `shell.openPath` — never `shell.openExternal` on the browser-openable URL.
 *
 * sanitize/uniquePath are deliberately duplicated from file-sink.ts's
 * versions rather than importing them — zero blast radius on the working
 * Phase 10 P2P-transfer code for what is otherwise a two-line helper.
 */

/**
 * Strip path separators, leading dots, characters Windows will not keep in a
 * file name, and trailing dots/spaces from a server-supplied filename.
 *
 * Applied on every platform rather than only win32: a stray colon or trailing dot
 * is never worth preserving in a download name, and the check below is only as
 * good as the name it is given. Windows silently drops trailing dots and spaces
 * when it creates a file, so "evil.exe." IS evil.exe on disk — yet extname() sees
 * no extension in it and the executable check waved it through to shell.openPath.
 * A colon would instead address an NTFS alternate data stream ("x.exe:payload").
 */
export function sanitize(name: string): string {
  const base = name
    .replace(/[/\\<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .trim();
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

// Extensions Windows will run on double-click with no "Mark of the Web"
// SmartScreen prompt — files this handler writes via fs.createWriteStream
// never get that tag (only a browser download does), so an attachment saved
// and then opened the normal way (shell.openPath) would auto-execute.
//
// Also covers container formats that Explorer auto-mounts on double-click:
// MOTW does not propagate to a file INSIDE a mounted .iso/.img/.vhd(x), so a
// malicious .exe hidden inside one loses its SmartScreen warning entirely —
// the same silent-execution outcome as the extensions above, one level of
// indirection removed.
const EXECUTABLE_EXTENSIONS = new Set([
  ".exe", ".scr", ".js", ".jse", ".bat", ".cmd", ".msi", ".ps1",
  ".vbs", ".vbe", ".wsf", ".wsh", ".cpl", ".com", ".pif", ".reg",
  ".lnk", ".hta", ".msc", ".jar",
  ".iso", ".img", ".vhd", ".vhdx",
  ".url", ".chm", ".appref-ms", ".settingcontent-ms", ".website",
]);

/** Checked against the SAVED/sanitized path, not the sender-supplied
 *  filename — what matters is what will actually land on disk and be handed
 *  to shell.openPath. */
export function isExecutableAttachment(savedPath: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(extname(savedPath).toLowerCase());
}

// Bounds the WHOLE download, not just time-to-first-byte — Node's fetch has no
// separate "headers took too long" signal, and reusing update-integrity.ts's
// 10s (sized for a tiny manifest) would abort a large-but-healthy attachment
// on a slow connection. Generous enough to let a real transfer finish; short
// enough that a server that never responds at all can't hang this IPC handler
// (and the renderer's "downloading" state with it) indefinitely.
const FETCH_TIMEOUT_MS = 5 * 60_000;

export function registerAttachmentOpen(getMainWindow: () => BrowserWindow | null): void {
  // Same trust boundary as index.ts's fromMainWindow: this handler fetches an
  // arbitrary URL and writes/opens a file, so only the main window's
  // webContents may drive it. Locally-scoped (rather than importing
  // index.ts's private helper) to avoid a circular dependency — see
  // updater.ts/window-state-guard.ts for the same getMainWindow-getter
  // pattern.
  const fromMainWindow = (e: { sender: Electron.WebContents }): boolean =>
    e.sender === getMainWindow()?.webContents;

  ipcMain.handle(
    "attachment:open",
    async (
      e,
      { url, fileName }: { url: string; fileName: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!fromMainWindow(e)) return { ok: false, error: "Refused: not the main window." };

      // Validate BEFORE ever touching the network — the renderer is treated
      // as hostile input for anything that reaches the OS, same rule as
      // openExternal/setWindowOpenHandler in harden.ts.
      const safe = safeExternalUrl(url);
      if (!safe) return { ok: false, error: "Refused an unsafe URL." };

      let path: string | undefined;
      try {
        const res = await fetch(safe, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return { ok: false, error: `Download failed (${res.status}).` };
        if (!res.body) return { ok: false, error: "Empty response body." };
        path = uniquePath(sanitize(fileName || "download"));
        // Streamed straight to disk rather than buffered whole into memory
        // first (the previous `Buffer.from(await res.arrayBuffer())`): this is
        // the main process, not a renderer — one large attachment held in its
        // heap at once is a much bigger blast radius than in an ordinary tab,
        // since an OOM here takes every window down at once. Nothing later in
        // this handler needs the full buffer — the executable-extension check
        // runs on the saved PATH, not the bytes.
        // fetch's res.body types against lib.dom's ReadableStream; Readable.fromWeb
        // wants node:stream/web's — the same runtime object, two nominal TS
        // types with no overlap the compiler can see.
        await pipeline(
          Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
          createWriteStream(path),
        );
        if (isExecutableAttachment(path)) {
          // Never auto-run an executable-class attachment — reveal it in the
          // file manager and make the user open it themselves.
          shell.showItemInFolder(path);
          return { ok: true };
        }
        const failure = await shell.openPath(path);
        if (failure) {
          await unlink(path).catch(() => {});
          return { ok: false, error: failure };
        }
        return { ok: true };
      } catch (err) {
        if (path) await unlink(path).catch(() => {});
        return { ok: false, error: err instanceof Error ? err.message : "Could not open the file." };
      }
    },
  );
}
