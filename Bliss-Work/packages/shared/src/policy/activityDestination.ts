/**
 * Turning a raw foreground reading into a name a person recognises.
 *
 * ── What the producers record, and why this is separate from them ────────────
 * The agents record the AGGREGATABLE fact and nothing else: the desktop sampler
 * stores the operating system's application name, the browser extension stores
 * the registrable domain. Both go in `targetId`, in the clear, because every
 * rollup in telemetry-svc groups by it — `topApps`, `topSites`, and the
 * "time outside BlissWork" figure on the analytics tab all read that column.
 *
 * Normalising at WRITE time would have been fewer moving parts and was rejected
 * for exactly that reason: rewriting `youtube.com` to `YouTube` on the way in
 * splits every historical rollup in two, and a display name is a decision that
 * changes (a product gets renamed, a mapping is added) while a domain is a fact
 * that does not. So the column keeps the fact and this file makes it readable,
 * which also means adding a mapping here improves every row already stored.
 *
 * ── The map is deliberately short ────────────────────────────────────────────
 * It covers what people actually switch to often enough that the raw form reads
 * badly, and stops. It is not an attempt to name the web: the fallback already
 * produces something honest for everything else — `example-company.com` stays
 * `example-company.com`, and `SomeApp.exe` becomes `SomeApp` — so an unmapped
 * destination is readable rather than wrong. Add entries when a real one turns
 * up; never invent a name the reading does not support (see `resolveApp`).
 */

/**
 * How a producer says "the user was in BlissWork itself".
 *
 * A marker rather than a domain or an executable name, because only the
 * PRODUCER can answer it: the extension knows which host it was enrolled
 * against, and the desktop agent knows what its own process is called. A reader
 * looking at a stored row cannot tell `acme.blisswork.com` from any other
 * domain, so the answer travels with the row instead of being re-derived.
 *
 * The browser extension writes this literal directly — it ships as a
 * dependency-free bundle and cannot import this package. If this value ever
 * changes, apps/extension/src/tracker.ts changes with it.
 */
export const BLISSWORK_DESTINATION = "BlissWork";

/** What kind of thing a destination is. Mirrors `targetKind` on the stored row. */
export type DestinationKind = "app" | "site";

/**
 * Registrable domain → display name.
 *
 * Keyed on the domain the extension actually stores (see `registrableDomain` in
 * apps/extension/src/tracker.ts — `www.` is already stripped and the host is
 * lowercased), so lookups are exact rather than fuzzy.
 *
 * Some products answer to more than one domain. Those are listed separately and
 * point at the same name, which is the whole reason this is a map rather than a
 * prettifier: `chat.openai.com` and `chatgpt.com` are one destination to a
 * person reading the timeline.
 */
const SITE_NAMES: Readonly<Record<string, string>> = {
  "youtube.com": "YouTube",
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "openai.com": "OpenAI",
  "claude.ai": "Claude",
  "github.com": "GitHub",
  "gitlab.com": "GitLab",
  "stackoverflow.com": "Stack Overflow",
  "google.com": "Google",
  "docs.google.com": "Google Docs",
  "drive.google.com": "Google Drive",
  "mail.google.com": "Gmail",
  "calendar.google.com": "Google Calendar",
  "meet.google.com": "Google Meet",
  "netflix.com": "Netflix",
  "spotify.com": "Spotify",
  "linkedin.com": "LinkedIn",
  "x.com": "X",
  "twitter.com": "X",
  "reddit.com": "Reddit",
  "facebook.com": "Facebook",
  "instagram.com": "Instagram",
  "whatsapp.com": "WhatsApp",
  "slack.com": "Slack",
  "notion.so": "Notion",
  "figma.com": "Figma",
  "atlassian.net": "Jira",
  "office.com": "Microsoft 365",
  "outlook.com": "Outlook",
  "office365.com": "Microsoft 365",
  "sharepoint.com": "SharePoint",
  "zoom.us": "Zoom",
  "amazon.com": "Amazon",
  "wikipedia.org": "Wikipedia",
};

/**
 * Application name → display name.
 *
 * Keyed in lower case, and looked up both with and without a `.exe` suffix,
 * because the two platforms report different things for the same program:
 * Windows gives an executable (`Code.exe`, `WINWORD.EXE`) and macOS gives the
 * bundle's display name (`Visual Studio Code`). Both forms are listed where
 * they differ, so neither platform depends on the fallback to look right.
 */
const APP_NAMES: Readonly<Record<string, string>> = {
  // Editors and terminals
  code: "VS Code",
  "code - insiders": "VS Code",
  "visual studio code": "VS Code",
  devenv: "Visual Studio",
  idea64: "IntelliJ IDEA",
  pycharm64: "PyCharm",
  sublime_text: "Sublime Text",
  windowsterminal: "Windows Terminal",
  terminal: "Terminal",
  iterm2: "iTerm",
  // Microsoft Office
  winword: "Microsoft Word",
  excel: "Microsoft Excel",
  powerpnt: "Microsoft PowerPoint",
  outlook: "Outlook",
  onenote: "OneNote",
  "microsoft outlook": "Outlook",
  "microsoft word": "Microsoft Word",
  "microsoft excel": "Microsoft Excel",
  // Communication
  teams: "Microsoft Teams",
  "ms-teams": "Microsoft Teams",
  "microsoft teams": "Microsoft Teams",
  slack: "Slack",
  discord: "Discord",
  zoom: "Zoom",
  // Browsers. Named so a row reads "Google Chrome" rather than "chrome.exe" —
  // but a browser in the foreground is a COARSE reading, and the extension's
  // site row is the better one when both exist. See `isBrowser`.
  chrome: "Google Chrome",
  "google chrome": "Google Chrome",
  msedge: "Microsoft Edge",
  "microsoft edge": "Microsoft Edge",
  firefox: "Firefox",
  safari: "Safari",
  brave: "Brave",
  opera: "Opera",
  arc: "Arc",
  // Shell and system
  explorer: "File Explorer",
  finder: "Finder",
  notepad: "Notepad",
  spotify: "Spotify",
};

/**
 * Applications whose foreground reading says nothing about what the person was
 * looking at.
 *
 * "They were in Chrome" is true and almost useless — the interesting fact is
 * the site, which the browser extension records separately and far more
 * precisely. Callers use this to prefer the site row when both describe the
 * same moment, rather than showing one switch twice at two resolutions.
 *
 * Keyed on the RESOLVED display name, so one entry covers every spelling the
 * two platforms produce for the same browser.
 */
const BROWSER_NAMES: ReadonlySet<string> = new Set([
  "Google Chrome", "Microsoft Edge", "Firefox", "Safari", "Brave", "Opera", "Arc",
]);

/** Whether a resolved destination name is a web browser — a coarse reading that
 *  a site row supersedes. */
export function isBrowser(name: string | null | undefined): boolean {
  return !!name && BROWSER_NAMES.has(name);
}

/**
 * Whether a destination IS BlissWork.
 *
 * Loose on purpose. The producers send the marker where they can resolve it,
 * but the desktop agent also reports its own foreground span under whatever the
 * operating system calls the packaged application — `BlissWork`,
 * `BlissWork.exe`, `BlissWork Desktop` — and that varies by platform and by
 * build channel. The same substring test already decides what to exclude from
 * "time outside BlissWork" on the analytics tab, so the timeline and the
 * analytics cannot disagree about which rows are us.
 */
export function isBlissWork(name: string | null | undefined): boolean {
  return !!name && /blisswork/i.test(name);
}

/** Everything after the last dot, when that looks like an executable suffix. */
const EXE_SUFFIX = /\.(exe|app)$/i;

/**
 * A domain's display name.
 *
 * Falls back to the domain itself, which is the honest answer: `example-
 * company.com` is already something a reader recognises, and inventing a
 * prettier name for it would be guessing. `www.` is stripped defensively —
 * the extension already does it, but rows predating that, or from another
 * producer, should not read differently.
 */
export function resolveSite(domain: string | null | undefined): string | null {
  const key = (domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!key) return null;
  return SITE_NAMES[key] ?? key;
}

/**
 * An application's display name.
 *
 * Falls back to the reported name with any `.exe`/`.app` suffix removed, which
 * keeps a genuinely unmapped application readable (`Ledger.exe` → `Ledger`)
 * instead of discarding a real reading in favour of a placeholder. Null — which
 * callers render as "another application" — is reserved for the case where the
 * operating system gave us nothing at all, because requirement one of this
 * feature is that an unknown destination is never dressed up as a known one.
 */
export function resolveApp(name: string | null | undefined): string | null {
  const raw = (name ?? "").trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  const stripped = key.replace(EXE_SUFFIX, "");
  const mapped = APP_NAMES[key] ?? APP_NAMES[stripped];
  if (mapped) return mapped;
  // Unmapped: give back what the OS said, minus the suffix, with the original
  // capitalisation. `WINWORD.EXE` would be shouted back, so an all-caps name
  // that is not a known acronym is title-cased.
  const out = raw.replace(EXE_SUFFIX, "");
  return out === out.toUpperCase() && out.length > 3 ? titleCase(out) : out;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * The display name for one end of a switch — either end, source or destination.
 *
 * `BLISSWORK_DESTINATION` passes through unchanged: it is already a name, and
 * it is the one value the producer resolved rather than observed.
 */
export function resolveDestination(
  kind: DestinationKind | string | null | undefined,
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value === BLISSWORK_DESTINATION) return BLISSWORK_DESTINATION;
  return kind === "site" ? resolveSite(value) : resolveApp(value);
}
