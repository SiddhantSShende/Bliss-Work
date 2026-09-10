/**
 * ⚠️ KEEP IN SYNC with Bliss-Work/packages/ui/src/lib/cn.ts — this is a
 * byte-for-byte copy. Same git repo (not separate repos, no submodules), but
 * Bliss-Website is a standalone deployable with its own package.json/lockfile
 * and node_modules, intentionally not part of Bliss-Work's npm workspace (see
 * the header comment in vite.config.ts), so importing the real thing would
 * require restructuring how this site is built/deployed — not worth it for
 * one 3-line function. Any change here must be mirrored there, or vice versa —
 * grep for `cn.ts` in the other tree before editing.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
