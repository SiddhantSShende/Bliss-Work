/**
 * Which platforms have the main-process activity tracker — the one that reads
 * the OS's own idle counter (main/activity-tracker.ts).
 *
 * Where it exists, it is the authority on idle and active time, and the
 * renderer must stop accruing its own: the renderer can only see input that
 * lands in its own window, so it reads someone working in another application
 * as idle. Where it does not exist, the renderer's accounting is all there is
 * and must keep running — so this single answer is what main uses to decide
 * whether to build the tracker AND what the preload tells the renderer, and the
 * two can therefore never disagree.
 *
 * Dependency-free (no electron import) so both bundles can use it.
 */
export function hasOsActivityTracking(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}
