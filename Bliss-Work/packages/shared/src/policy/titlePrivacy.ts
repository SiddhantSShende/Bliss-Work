/**
 * The desktop activity sensor's title-privacy floor.
 *
 * `apps/desktop/src/main/activity-agent.ts` reads the OS-reported window title
 * for whichever application is in front — necessary for "Learn Go in 30
 * Minutes" instead of just "Chrome", but a window title is an OS string with no
 * structure to it, so it can just as easily say "1Password — chase.com" or
 * "Slack — DM with Alex: <preview>". The browser extension has a domain-based
 * floor for exactly this class of problem (`apps/extension/src/tracker.ts`'s
 * `NEVER_RECORD`); this is that floor's desktop-side counterpart, for a sensor
 * that has no domain to match against — only an application identity and a
 * title string.
 *
 * ── Two floors, not one, because the two leaks are different shapes ──────────
 * `SENSITIVE_APPS` — an application whose title IS the sensitive content by
 * construction (a password manager's title bar names the site/account you're
 * logged into). No title from one of these is ever safe to keep, so the whole
 * field is dropped, the same "omit the field entirely" behaviour
 * `activity-agent.ts` already applies to any other title it could not read.
 *
 * `TITLE_KEYWORDS` — an ordinary application whose title HAPPENS to reveal
 * something revealing on this occasion — a browser tab's title read via the
 * desktop sensor (the extension has already left the building at this point,
 * so this is the desktop-only path), a Finder window, a Mail client. Matched
 * against the title text itself rather than the application, because the
 * application here is not the problem.
 *
 * Both lists are a FLOOR, matching `NEVER_RECORD`'s own framing: never
 * overridden by configuration, because a workplace monitoring tool that logs a
 * password manager's title or a "Re: biopsy results" email subject has stopped
 * being a workplace monitoring tool.
 */

/**
 * Applications whose title is dropped outright — the app name (`targetId`)
 * is still recorded, only `detail.title` is withheld.
 *
 * Matched case-insensitively against the resolved display name
 * (`resolveApp(name)`), not the raw executable/bundle string, so one entry
 * covers every platform's spelling. None of these names are in
 * `activityDestination.ts`'s `APP_NAMES` map, so `resolveApp` passes an
 * unmapped app's OS-reported casing straight through — the comparison in
 * `isSensitiveApp` has to normalize case itself rather than assume
 * `resolveApp` already did it.
 */
const SENSITIVE_APPS: ReadonlySet<string> = new Set([
  "1password", "bitwarden", "lastpass", "dashlane", "keepass", "keepassxc",
  "nordpass", "keeper", "roboform", "proton pass",
]);

/**
 * Substrings that mark a title as revealing regardless of which application
 * produced it. Lower-cased; matched against the lower-cased title.
 *
 * Deliberately narrow — a floor this broad already trades recall for safety
 * (see NEVER_RECORD's own docstring on the same trade), and a keyword list
 * that swallows too much ordinary text stops being useful to anyone reading
 * the timeline. These cover the shapes of title that most reliably indicate
 * genuinely sensitive content: banking/financial one-time codes, health
 * information, and authentication prompts, which is the same category set
 * NEVER_RECORD protects for browser activity.
 */
const TITLE_KEYWORDS: readonly string[] = [
  "password", "passcode", "one-time code", "one time code", "otp",
  "verification code", "security code",
  "medical record", "patient", "diagnosis", "prescription",
  "bank statement", "account number", "routing number", "social security",
  "ssn", "tax return",
];

/**
 * Whether `appName` (the RESOLVED display name — see `resolveApp`) is a
 * sensitive application whose title should never be recorded.
 */
export function isSensitiveApp(appName: string | null | undefined): boolean {
  return !!appName && SENSITIVE_APPS.has(appName.toLowerCase());
}

/**
 * Whether `title` itself reads as revealing, regardless of application.
 */
export function isSensitiveTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const haystack = title.toLowerCase();
  return TITLE_KEYWORDS.some((k) => haystack.includes(k));
}

/**
 * The floor itself: the title the desktop sensor may actually keep, or `null`
 * to withhold it. `appName` is the RESOLVED name (`resolveApp(rawName)`), so a
 * caller holding only the raw OS reading must resolve it first — matching
 * every other consumer of `SENSITIVE_APPS`/`APP_NAMES` in this package.
 *
 * Never overridden by configuration, same as `NEVER_RECORD` — there is no
 * `captureAll`-equivalent escape hatch here, because unlike a browser domain
 * (which a workspace might have a real reason to want visibility into even
 * for a "sensitive" category), a password manager's title or a title
 * containing a verification code has no legitimate monitoring use.
 */
export function filterTitle(
  appName: string | null | undefined,
  title: string | null | undefined,
): string | null {
  if (!title) return null;
  if (isSensitiveApp(appName)) return null;
  if (isSensitiveTitle(title)) return null;
  return title;
}
