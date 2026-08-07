/**
 * Self-heal a stale lazy chunk.
 *
 * If the app is open (or index.html was cached) against an OLD hashed chunk that
 * a newer build removed, a dynamic `import()` 404s. Vite raises
 * `vite:preloadError`; reloading once fetches a fresh index.html and the current
 * chunk hashes. A short sessionStorage guard prevents a reload loop when the
 * chunk is genuinely unreachable (offline) rather than merely rotated.
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
    let last = 0;
    try {
      last = Number(sessionStorage.getItem("tb:chunk-reload") ?? 0);
    } catch {
      // sessionStorage can be unavailable in some embedded contexts; without the
      // guard we still recover, we just lose the anti-loop protection.
    }
    const now = Date.now();
    if (now - last < 10_000) return; // just reloaded — don't loop
    try {
      sessionStorage.setItem("tb:chunk-reload", String(now));
    } catch {
      /* see above */
    }
    event.preventDefault(); // suppress the unhandled error; we're recovering
    window.location.reload();
  });
}
