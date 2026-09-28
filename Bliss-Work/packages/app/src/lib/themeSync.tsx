/**
 * Keeps the account's theme in step across devices — web and desktop.
 *
 * The theme itself is still owned by ThemeProvider (packages/ui) and still
 * cached in localStorage, which the FOUC scripts read before React exists. What
 * this adds is the account copy (`themePrefs` on auth-svc's /auth/me, the same
 * endpoint the profile name and avatar already travel through) so a second
 * device, whose localStorage is a different one, can follow:
 *
 *   • PUSH — every change made in Settings / Profile → Dark Mode is reported by
 *     ThemeProvider's `onPrefsChange` and sent by `publishThemePrefs`.
 *   • PULL — `ThemeSync` reads /auth/me when the session starts and whenever
 *     the window regains focus, and adopts what it finds. There is no realtime
 *     push (no `user.*` event exists for profile changes), so a change made on
 *     one device shows on the other the next time it is looked at.
 *
 * Initial load, so both clients resolve to the same theme: the account copy
 * wins when there is one. When there is none yet (NULL — nobody has published)
 * a device that already has a choice of its own publishes it, and a device
 * that has only ever shown the default stays quiet rather than overwrite what
 * another device is about to publish.
 *
 * State is module-level rather than component state because a push is started
 * from ThemeProvider's callback and read again by the pull, in different
 * components; there is exactly one signed-in session per window.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { hasStoredThemeChoice, useTheme, type ThemePrefs } from "@taskboard/ui";
import { ApiError, type ApiClient } from "@taskboard/shared";
import i18n from "../i18n";
import { useSession } from "../store/session";
import { useRuntime } from "./runtime";

/** Focus and visibilitychange usually fire together; one read per burst. */
const MIN_PULL_INTERVAL_MS = 10_000;

let sending = false;
let queued: ThemePrefs | null = null;
/** The last push failed (offline, 5xx). The account copy is now OLDER than this
 *  device, so the next pull must retry the push instead of adopting it. Mirrored
 *  to localStorage (see UNSYNCED_KEY) so a reload does not forget it. */
let unsynced = false;
/** A person-made change is waiting to be sent; if it fails they are told. A
 *  background retry or first-run publish never sets this — nobody asked for it,
 *  so its failure is not worth interrupting anyone over. */
let notifyOnFailure = false;

/** Holds the id of the user whose latest theme change has NOT reached the
 *  account. Without it the flag above dies on reload, and the next pull adopts
 *  the older account copy — silently undoing a change the person made while
 *  offline. Keyed by user so it is never sent into someone else's account. */
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

/** Send this device's choice to the account. Sequential and latest-wins: two
 *  quick changes must not reach the server out of order and leave the older
 *  one stored. The change already applies locally; when a person-made one
 *  (`notify`) cannot be saved they are told so, because otherwise the other
 *  device silently never follows and nothing on screen says why. */
export function publishThemePrefs(api: ApiClient, prefs: ThemePrefs, opts: { notify?: boolean } = {}): void {
  const { status, user } = useSession.getState();
  if (status !== "authed" || !user) return;
  const userId = user.id;
  localVersion++;
  queued = prefs;
  if (opts.notify) notifyOnFailure = true;
  if (sending) return;
  sending = true;
  void (async () => {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        try {
          await api.updateProfile({ themePrefs: next });
          setUnsynced(userId, false);
        } catch (e) {
          setUnsynced(userId, !wasRefused(e));
          if (notifyOnFailure) {
            // A fixed id: repeated failures replace one toast instead of stacking.
            toast.error(i18n.t("settings:theme.syncFailed"), { id: "theme-sync-failed" });
          }
        }
        notifyOnFailure = false;
      }
    } finally {
      sending = false;
    }
  })();
}

function samePrefs(a: ThemePrefs, b: ThemePrefs): boolean {
  return (
    a.theme === b.theme &&
    a.customActive === b.customActive &&
    JSON.stringify(a.customColors) === JSON.stringify(b.customColors)
  );
}

async function pullThemePrefs(
  api: ApiClient,
  local: () => ThemePrefs,
  applyRemote: (prefs: ThemePrefs) => void,
): Promise<void> {
  const startedAt = localVersion;
  const { themePrefs: remote } = await api.me();
  // A change made while this read was in flight (or still on its way up) makes
  // what came back stale; adopting it would snap the choice back.
  if (localVersion !== startedAt || sending || queued) return;
  if (unsynced || remote === null) {
    if (unsynced || hasStoredThemeChoice()) publishThemePrefs(api, local());
    return;
  }
  if (!samePrefs(remote, local())) applyRemote(remote);
}

/** Renders nothing; mount once inside ThemeProvider and the session. */
export function ThemeSync() {
  const { api } = useRuntime();
  const userId = useSession((s) => s.user?.id);
  const { prefs, applyRemote } = useTheme();
  // Read through refs so the listeners below always see the current values
  // without being torn down and re-registered on every theme change.
  const latest = useRef({ prefs, applyRemote });
  latest.current = { prefs, applyRemote };

  useEffect(() => {
    if (!userId) return;
    // A different account (or a re-login) must not inherit the previous one's
    // pending push. The failure flag is the exception: it survives a reload for
    // the SAME user (their unsent change is still what this device shows), but
    // one left by anybody else is stale — this device is about to adopt THIS
    // account's copy, so the old change is gone from it — and is cleared.
    localVersion++;
    queued = null;
    notifyOnFailure = false;
    const owed = unsyncedUser();
    unsynced = owed === userId;
    if (owed && owed !== userId) setUnsynced(owed, false);

    let lastPull = 0;
    const pull = () => {
      const now = Date.now();
      if (now - lastPull < MIN_PULL_INTERVAL_MS) return;
      lastPull = now;
      pullThemePrefs(api, () => latest.current.prefs, (p) => latest.current.applyRemote(p)).catch(() => {
        // Offline or a transient error — the next focus tries again.
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") pull();
    };

    pull();
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", pull);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, userId]);

  return null;
}
