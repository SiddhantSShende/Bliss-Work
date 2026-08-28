import { app, ipcMain, shell } from "electron";
import { createWriteStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
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

/** Strip path separators / leading dots from a server-supplied filename. */
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

export function registerAttachmentOpen(): void {
  ipcMain.handle(
    "attachment:open",
    async (
      _e,
      { url, fileName }: { url: string; fileName: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      // Validate BEFORE ever touching the network — the renderer is treated
      // as hostile input for anything that reaches the OS, same rule as
      // openExternal/setWindowOpenHandler in harden.ts.
      const safe = safeExternalUrl(url);
      if (!safe) return { ok: false, error: "Refused an unsafe URL." };

      let path: string | undefined;
      try {
        const res = await fetch(safe);
        if (!res.ok) return { ok: false, error: `Download failed (${res.status}).` };
        const buf = Buffer.from(await res.arrayBuffer());
        path = uniquePath(sanitize(fileName || "download"));
        await new Promise<void>((resolve, reject) => {
          const ws = createWriteStream(path!);
          ws.on("error", reject);
          ws.on("finish", () => resolve());
          ws.end(buf);
        });
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
