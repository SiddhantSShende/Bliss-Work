/**
 * Synchronizes the user's single custom-theme definition across web and
 * desktop. The authenticated account's customTheme field is the cross-device
 * source of truth; selected preset, appearance, and custom activation remain
 * local to each device. Legacy themePrefs records are read only for migration.
 *
 * Pulls happen after authentication and on focus because the account profile
 * has no realtime update event. A revision distinguishes an explicit deletion
 * from a never-synchronized definition, preventing stale local cache from
 * resurrecting a removed palette.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { readStoredCustomTheme, useTheme, type CustomTheme } from "@taskboard/ui";
import { ApiError, type ApiClient } from "@taskboard/shared";
import i18n from "../i18n";
import { useSession } from "../store/session";
import { useRuntime } from "./runtime";

/** Focus and visibilitychange usually fire together; one read per burst. */
const MIN_PULL_INTERVAL_MS = 10_000;

let sending = false;
let queued: { customTheme: CustomTheme | null } | null = null;
/** Retry an unsynced definition instead of adopting an older account copy. */
let unsynced = false;
/** A person-made change is waiting to be sent; if it fails they are told. A
 *  background retry or first-run publish never sets this — nobody asked for it,
 *  so its failure is not worth interrupting anyone over. */
let notifyOnFailure = false;

/** Holds the user id for an unsynced custom definition across reloads. */
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

/** Send custom-definition updates sequentially; the latest queued change wins. */
export function publishCustomTheme(api: ApiClient, customTheme: CustomTheme | null, opts: { notify?: boolean } = {}): void {
  const { status, user } = useSession.getState();
  if (status !== "authed" || !user) return;
  const userId = user.id;
  localVersion++;
  queued = { customTheme: customTheme ? { colors: [...customTheme.colors] } : null };
  if (opts.notify) notifyOnFailure = true;
  if (sending) return;
  sending = true;
  void (async () => {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        try {
          await api.updateProfile({ customTheme: next.customTheme });
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

function sameCustomTheme(a: CustomTheme | null, b: CustomTheme | null): boolean {
  return JSON.stringify(a?.colors ?? null) === JSON.stringify(b?.colors ?? null);
}

async function pullCustomTheme(
  api: ApiClient,
  local: () => CustomTheme | null,
  applyRemote: (theme: CustomTheme | null) => void,
): Promise<void> {
  const startedAt = localVersion;
  const { customTheme, customThemeRevision, themePrefs } = await api.me();
  // A change made while this read was in flight (or still on its way up) makes
  // what came back stale; adopting it would snap the choice back.
  if (localVersion !== startedAt || sending || queued) return;
  const localTheme = local();
  if (unsynced) {
    publishCustomTheme(api, localTheme);
    return;
  }

  if (customThemeRevision != null) {
    const remoteTheme = customTheme ?? null;
    if (!sameCustomTheme(remoteTheme, localTheme)) applyRemote(remoteTheme);
    return;
  }

  // Older rows/servers only have the combined themePrefs shape. Migrate its
  // definition without ever adopting its device-specific theme/active fields.
  const legacyTheme = themePrefs?.customColors ? { colors: themePrefs.customColors } : null;
  if (legacyTheme) applyRemote(legacyTheme);
  else if (themePrefs === null && localTheme) publishCustomTheme(api, localTheme);
  else if (!sameCustomTheme(null, localTheme)) applyRemote(null);
}

/** Renders nothing; mount once inside ThemeProvider and the session. */
export function ThemeSync() {
  const { api } = useRuntime();
  const userId = useSession((s) => s.user?.id);
  const status = useSession((s) => s.status);
  const { customTheme, applyRemoteCustomTheme } = useTheme();
  // Read through refs so the listeners below always see the current values
  // without being torn down and re-registered on every theme change.
  const latest = useRef({ customTheme, applyRemoteCustomTheme });
  latest.current = { customTheme, applyRemoteCustomTheme };

  useEffect(() => {
    if (status !== "authed" || !userId) return;
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
      pullCustomTheme(
        api,
        () => latest.current.customTheme,
        (theme) => latest.current.applyRemoteCustomTheme(theme),
      ).catch(() => {
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
  }, [api, status, userId]);

  return null;
}
