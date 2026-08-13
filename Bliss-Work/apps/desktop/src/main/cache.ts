import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StickyTaskDTO } from "@taskboard/shared";

/**
 * Tiny file cache in userData. Holds the last-known actionable task list so
 * sticky widgets can paint instantly on launch (offline-first) before the WS
 * reconnects. Deliberately not a native DB — keeps first-run build-free.
 *
 * The cached tasks include user content (title / description), so the file is
 * encrypted AT REST via Electron safeStorage (OS keychain / Windows DPAPI /
 * libsecret) when a backend is available. It falls back to plaintext only when
 * the OS offers no encryption backend; a legacy plaintext cache is still read
 * and is transparently re-encrypted on the next write.
 */
interface CacheShape {
  tasks: StickyTaskDTO[];
}

let file = "";
let state: CacheShape = { tasks: [] };

export function initCache(): void {
  file = join(app.getPath("userData"), "taskboard-cache.json");
  if (!existsSync(file)) return;
  try {
    const raw = readFileSync(file);
    let json: string;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        json = safeStorage.decryptString(raw);
      } catch {
        json = raw.toString("utf8"); // legacy plaintext cache — migrated on next write
      }
    } else {
      json = raw.toString("utf8");
    }
    state = JSON.parse(json) as CacheShape;
  } catch {
    state = { tasks: [] };
  }
}

export function getTasks(): StickyTaskDTO[] {
  return state.tasks;
}

export function setTasks(tasks: StickyTaskDTO[]): void {
  state.tasks = tasks;
  try {
    const json = JSON.stringify(state);
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(file, safeStorage.encryptString(json));
    } else {
      writeFileSync(file, json);
    }
  } catch {
    /* best-effort */
  }
}
