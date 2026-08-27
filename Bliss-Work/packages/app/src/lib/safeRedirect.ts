/**
 * Validate a post-login `redirect` target before navigating to it.
 *
 * Must be a same-app relative path: a single leading `/` and nothing that
 * could be read as a protocol-relative or backslash-prefixed URL (`//evil`,
 * `/\evil`), which browsers can treat as pointing off-origin. React Router's
 * own `<Navigate>` would refuse to actually leave the origin (`pushState`
 * enforces same-origin), so this is defense in depth against a malformed
 * value crashing that call rather than a true open-redirect fix.
 */
export function safeRedirect(target: string | null | undefined, fallback = "/app"): string {
  if (!target) return fallback;
  if (!target.startsWith("/")) return fallback;
  if (target.startsWith("//") || target.startsWith("/\\")) return fallback;
  return target;
}
