/**
 * `taskboard://` deep-link parsing.
 *
 * Deep links arrive from three different places depending on platform and
 * whether the app was already running:
 *
 *   - `open-url`         macOS, any time
 *   - `second-instance`  Windows/Linux, app already running (URL is in argv)
 *   - `process.argv`     Windows/Linux COLD START — the link launched the app
 *
 * All three funnel into `parseDeepLink`, which is pure so the routing can be
 * tested without booting Electron. The main process only decides which IPC
 * channel to send the result on.
 *
 * Kept dependency-free (no electron import) for exactly that reason.
 */

export interface OAuthDeepLink {
  kind: "oauth";
  connected?: string;
  error?: string;
}

export interface InviteDeepLink {
  kind: "invite";
  token: string;
}

export type DeepLink = OAuthDeepLink | InviteDeepLink;

/**
 * Extract the host from a custom-scheme URL.
 *
 * Custom schemes are NOT special-scheme URLs, so the WHATWG parser treats them
 * as opaque: `taskboard://oauth?x=1` may expose "oauth" as `hostname` on one
 * platform and as `pathname` ("//oauth") on another, depending on how the OS
 * handed us the string. Reading both is what makes this work cross-platform.
 */
function hostOf(u: URL): string {
  if (u.hostname) return u.hostname;
  return u.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
}

/**
 * Parse one deep link, or return null if it is not one we handle.
 *
 * Returns null rather than throwing: these strings come from the OS via argv,
 * where unrelated command-line arguments also live, so "not a link for us" is
 * the common case, not an error.
 */
export function parseDeepLink(url: string | undefined | null): DeepLink | null {
  if (!url) return null;

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  // Only our own scheme. Without this check any URL in argv with a `token`
  // query param — including an https one an attacker got into a shortcut —
  // would be treated as an invite.
  if (u.protocol !== "taskboard:") return null;

  if (hostOf(u) === "oauth") {
    return {
      kind: "oauth",
      connected: u.searchParams.get("connected") ?? undefined,
      error: u.searchParams.get("error") ?? undefined,
    };
  }

  // The invite branch keys off the `token` param rather than the host, because
  // links already sitting in users' inboxes don't all carry a consistent host.
  const token = u.searchParams.get("token");
  if (token) return { kind: "invite", token };

  return null;
}

/** Find the first deep link in an argv-style array (cold start / second-instance). */
export function findDeepLink(argv: readonly string[]): string | undefined {
  return argv.find((a) => typeof a === "string" && a.startsWith("taskboard://"));
}
