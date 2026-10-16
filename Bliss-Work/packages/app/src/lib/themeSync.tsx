/**
 * Synchronizes the whole account-wide theme document — preset, light/dark
 * (folded into the preset id, e.g. "rose-dark"), whether Custom is active, and
 * the custom palette definition — across every authenticated web and desktop
 * session. auth-svc's `users.theme_prefs` row is the cross-device source of
 * truth; `PATCH /auth/me` bumps a shared revision on every write, which lets a
 * stale in-flight GET be told apart from a fresh one.
 *
 * Pulls happen after authentication, on focus, AND the instant another
 * session's write is pushed over the websocket (see
 * notifyRemoteThemePrefsChanged / EventType.UserThemePrefsChanged) — the push
 * is what makes propagation not depend on refocusing or waiting for a poll.
 * Focus/visibility stay as the fallback for whenever the socket itself is
 * down. `themePrefs === null` (the account has never synced from ANY device)
 * is the one case this device's own state is allowed to win and get published.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { isThemeId, defaultThemeFor, useTheme, type ThemePrefsSnapshot } from "@taskboard/ui";
import { ApiError, type ApiClient } from "@taskboard/shared";
import i18n from "../i18n";
import { useSession } from "../store/session";
import { useRuntime } from "./runtime";

/** Focus and visibilitychange usually fire together; one read per burst. A
 *  server push (see notifyRemoteThemePrefsChanged) always bypasses this — it
 *  is a distinct signal that something actually changed, not a guess. */
const MIN_PULL_INTERVAL_MS = 10_000;
const RECONCILE_INTERVAL_MS = 60_000;

type QueuedPrefs = { userId: string; prefs: ThemePrefsSnapshot; notify: boolean };
let sending = false;
let queued: QueuedPrefs | null = null;
let revisionUserId: string | null = null;
let themeRevision = 0;
/** Retry an unsynced change instead of adopting an older account copy. */
let unsynced = false;

/** Holds the user id for an unsynced change across reloads. */
const UNSYNCED_KEY = "tb-theme-unsynced";

function unsyncedUser(): string | null {
  try {
    return localStorage.getItem(UNSYNCED_KEY);
  } catch {
    return null;
  }
}

function setUnsynced(userId: string, on: boolean): void {
  unsynced = on;
  try {
    if (on) localStorage.setItem(UNSYNCED_KEY, userId);
    else if (unsyncedUser() === userId) localStorage.removeItem(UNSYNCED_KEY);
  } catch {
    // In-memory flag still covers this session.
  }
}

/** The server looked at this value and refused it (validation, permissions).
 *  Resending cannot succeed, so keeping it "unsynced" would strand this device
 *  on a value the account will never take. A lapsed session (401), a timeout
 *  (408) or throttling (429) are transient and stay retryable. */
function wasRefused(e: unknown): boolean {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
}
/** Bumped on every local change; a pull that started before a change discards
 *  its result, because what it read no longer reflects the latest choice. */
let localVersion = 0;
let pullVersion = 0;

/** Lets a server push nudge the mounted ThemeSync to re-pull immediately,
 *  without it having to know anything about ws transport. No-op if nothing is
 *  mounted — the next mount's own initial pull already reads current state. */
let pullNow: (() => void) | null = null;

/** Call when `EventType.UserThemePrefsChanged` arrives over the websocket —
 *  another session on this account just changed the theme document. */
export function notifyRemoteThemePrefsChanged(): void {
  pullNow?.();
}

function samePrefs(a: ThemePrefsSnapshot, b: ThemePrefsSnapshot): boolean {
  return (
    a.theme === b.theme &&
    a.customActive === b.customActive &&
    JSON.stringify(a.customTheme?.colors ?? null) === JSON.stringify(b.customTheme?.colors ?? null)
  );
}

/** A brand-new device/account that has touched nothing — publishing this is
 *  pointless noise when the account has never synced either (see
 *  pullThemePrefs's `themePrefs == null` branch). */
function isDefaultPrefs(p: ThemePrefsSnapshot): boolean {
  return !p.customActive && p.customTheme === null && p.theme === defaultThemeFor(false);
}

/** Send prefs updates sequentially; the latest queued change wins. */
export function publishThemePrefs(api: ApiClient, prefs: ThemePrefsSnapshot, opts: { notify?: boolean } = {}): void {
  const { status, user } = useSession.getState();
  if (status !== "authed" || !user) return;
  const userId = user.id;
  localVersion++;
  queued = {
    userId,
    prefs: { theme: prefs.theme, customActive: prefs.customActive, customTheme: prefs.customTheme ? { colors: [...prefs.customTheme.colors] } : null },
    notify: Boolean(opts.notify || queued?.notify),
  };
  if (sending) return;
  sending = true;
  void (async () => {
    let reconcileAfterSend = false;
    try {
      while (queued) {
        const next: QueuedPrefs | null = queued;
        if (!next) break;
        queued = null;
        if (useSession.getState().status !== "authed" || useSession.getState().user?.id !== next.userId) continue;
        const expectedThemeRevision = revisionUserId === next.userId ? themeRevision : 0;
        try {
          const updated = await api.updateProfile({
            themePrefs: {
              theme: next.prefs.theme,
              customColors: next.prefs.customTheme?.colors ?? null,
              customActive: next.prefs.customActive,
            },
            expectedThemeRevision,
          });
          if (useSession.getState().user?.id === next.userId) {
            revisionUserId = next.userId;
            themeRevision = updated.customThemeRevision ?? expectedThemeRevision + 1;
            setUnsynced(next.userId, false);
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && useSession.getState().user?.id === next.userId) {
            try {
              const latest = await api.me();
              if (useSession.getState().user?.id === next.userId) {
                revisionUserId = next.userId;
                themeRevision = latest.customThemeRevision ?? 0;
                setUnsynced(next.userId, false);
                if (!queued) reconcileAfterSend = true;
                else continue;
                if (next.notify) {
                  toast.error(i18n.t("settings:theme.syncFailed"), { id: "theme-sync-failed" });
                }
                continue;
              }
            } catch {
              // The stale snapshot is not safe to resend without the latest row.
            }
            if (useSession.getState().user?.id === next.userId) {
              queued = null;
              setUnsynced(next.userId, false);
              reconcileAfterSend = true;
              if (next.notify) {
                toast.error(i18n.t("settings:theme.syncFailed"), { id: "theme-sync-failed" });
              }
            }
            continue;
          }
          if (useSession.getState().user?.id === next.userId) setUnsynced(next.userId, !wasRefused(e));
          if (next.notify && useSession.getState().user?.id === next.userId) {
            // A fixed id: repeated failures replace one toast instead of stacking.
            toast.error(i18n.t("settings:theme.syncFailed"), { id: "theme-sync-failed" });
          }
        }
      }
    } finally {
      sending = false;
      if (reconcileAfterSend) pullNow?.();
    }
  })();
}

async function pullThemePrefs(
  api: ApiClient,
  userId: string,
  local: () => ThemePrefsSnapshot,
  applyRemote: (prefs: ThemePrefsSnapshot) => void,
): Promise<void> {
  const startedAt = localVersion;
  const thisPull = ++pullVersion;
  const { themePrefs, customThemeRevision } = await api.me();
  // A change made while this read was in flight (or still on its way up) makes
  // what came back stale; adopting it would snap every field back.
  if (localVersion !== startedAt || thisPull !== pullVersion || sending || queued) return;
  revisionUserId = userId;
  themeRevision = customThemeRevision ?? 0;
  const localPrefs = local();
  if (unsynced) {
    publishThemePrefs(api, localPrefs);
    return;
  }

  if (themePrefs == null) {
    // The account has never synced from ANY device — this device's own choice
    // (if it made one) becomes the account's first record.
    if (!isDefaultPrefs(localPrefs)) publishThemePrefs(api, localPrefs);
    return;
  }

  const remotePrefs: ThemePrefsSnapshot = {
    theme: isThemeId(themePrefs.theme) ? themePrefs.theme : defaultThemeFor(false),
    customActive: themePrefs.customActive,
    customTheme: themePrefs.customColors ? { colors: [...themePrefs.customColors] } : null,
  };
  if (!samePrefs(remotePrefs, localPrefs)) applyRemote(remotePrefs);
}

/** Renders nothing; mount once inside ThemeProvider and the session. */
export function ThemeSync() {
  const { api } = useRuntime();
  const userId = useSession((s) => s.user?.id);
  const status = useSession((s) => s.status);
  const { theme, customTheme, customThemeActive, applyRemotePrefs } = useTheme();
  // Read through refs so the listeners below always see the current values
  // without being torn down and re-registered on every theme change.
  const latest = useRef({ theme, customTheme, customThemeActive, applyRemotePrefs });
  latest.current = { theme, customTheme, customThemeActive, applyRemotePrefs };

  useEffect(() => {
    if (status !== "authed" || !userId) return;
    // A different account (or a re-login) must not inherit the previous one's
    // pending push. The failure flag is the exception: it survives a reload for
    // the SAME user (their unsent change is still what this device shows), but
    // one left by anybody else is stale — this device is about to adopt THIS
    // account's copy, so the old change is gone from it — and is cleared.
    localVersion++;
    queued = null;
    revisionUserId = userId;
    themeRevision = 0;
    const owed = unsyncedUser();
    unsynced = owed === userId;
    if (owed && owed !== userId) setUnsynced(owed, false);

    let lastPull = 0;
    const doPull = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastPull < MIN_PULL_INTERVAL_MS) return;
      lastPull = now;
      pullThemePrefs(
        api,
        userId,
        () => ({
          theme: latest.current.theme,
          customActive: latest.current.customThemeActive,
          customTheme: latest.current.customTheme,
        }),
        (prefs) => latest.current.applyRemotePrefs(prefs),
      ).catch(() => {
        // Offline or a transient error — the next focus (or push) tries again.
      });
    };
    const pull = () => doPull(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") pull();
    };

    pull();
    pullNow = () => doPull(true);
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", onVisibility);
    const reconcile = window.setInterval(() => {
      if (document.visibilityState === "visible") doPull(true);
    }, RECONCILE_INTERVAL_MS);
    return () => {
      pullNow = null;
      window.removeEventListener("focus", pull);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(reconcile);
    };
  }, [api, status, userId]);

  return null;
}
