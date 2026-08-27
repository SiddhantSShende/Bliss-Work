const GUARD_KEY = "tb:chunk-reload";
const LOOP_GUARD_MS = 10_000;

/**
 * Reload the page once to recover from a stale/unreachable chunk, guarded by
 * `GUARD_KEY` against a reload loop when the chunk is genuinely unreachable
 * (offline) rather than merely rotated by a newer deploy. Returns whether it
 * actually reloaded — `false` means the guard was hit and NOTHING was done,
 * which callers should treat as "let this failure surface normally" rather
 * than silently swallowing it a second time.
 *
 * Exported (not private to the `vite:preloadError` listener below) so a lazy
 * load that TIMES OUT instead of outright failing — e.g. `lazyRoute` in
 * App.tsx, racing `import()` against a deadline via `withLoadTimeout` — gets
 * the identical recovery. From the user's point of view a chunk that never
 * settles and a chunk that 404s are the same failure; only Vite tells the two
 * apart, and only for the second one.
 */
export function reloadForStaleChunk(): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(GUARD_KEY) ?? 0);
  } catch {
    // sessionStorage can be unavailable in some embedded contexts; without the
    // guard we still recover, we just lose the anti-loop protection.
  }
  const now = Date.now();
  if (now - last < LOOP_GUARD_MS) return false; // just reloaded — don't loop
  try {
    sessionStorage.setItem(GUARD_KEY, String(now));
  } catch {
    /* see above */
  }
  window.location.reload();
  return true;
}

/**
 * Self-heal a stale lazy chunk.
 *
 * If the app is open (or index.html was cached) against an OLD hashed chunk that
 * a newer build removed, a dynamic `import()` 404s. Vite raises
 * `vite:preloadError`; reloading once fetches a fresh index.html and the current
 * chunk hashes. See `reloadForStaleChunk` for the guard against a reload loop
 * when the chunk is genuinely unreachable (offline) rather than merely rotated.
 *
 * This lives in the shared package because BOTH entries need it. It was
 * web-only, which quietly left Electron with no recovery at all for the lazy
 * `import("exceljs")` behind Export Tasks (see lib/xlsxExport.ts) — a failure
 * there surfaced as an unhandled error rather than a reload. Desktop chunks ship
 * inside app.asar and can't rotate under a running app, so the reload path is
 * rarer there, but a failed import is exactly as fatal to the feature and
 * reloading a file:// document is a safe recovery.
 */
export function installChunkReloadRecovery(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("vite:preloadError", (event) => {
    // Only suppress the error when we're actually about to reload — the same
    // failure hitting the loop guard is left unhandled on purpose, so a
    // genuinely-unreachable chunk (offline) still surfaces as a visible
    // error instead of being silently swallowed a second time.
    if (reloadForStaleChunk()) event.preventDefault();
  });
}
