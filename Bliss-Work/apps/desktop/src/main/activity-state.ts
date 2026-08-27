import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

/**
 * Consent and pairing state for the desktop activity agent.
 *
 * Lives in the MAIN process and on disk, never in the renderer. Two reasons:
 * the renderer is the part an XSS would reach, and the sampler has to keep
 * working with every window closed — the state that decides whether it samples
 * cannot live somewhere that disappears with the UI.
 *
 * Layout on disk (userData/activity-agent.json):
 *   { version: 2, enabled, token, consentedVersion, accountId, deviceKey }
 *
 * `consentedVersion` is the app version at which the person last agreed. Users
 * never reinstall — the auto-updater replaces the app in place — so a
 * first-INSTALL prompt would mean this capability arriving silently on machines
 * that already had BlissWork. Keying consent to the version is what forces the
 * dialog to appear again when what is being sampled changes.
 *
 * `accountId` and `deviceKey` (added in version 2, for automatic provisioning)
 * are documented on `setSignedInAccount` and `getDeviceKey` respectively.
 */
export interface ActivityAgentState {
  version: 2;
  enabled: boolean;
  token: string | null;
  consentedVersion: string | null;
  /** Which BlissWork account this pairing belongs to. `null` on a state file
   *  written before this field existed (or one that was never bound to a
   *  signed-in session yet) — see `setSignedInAccount` for what that is and
   *  is not allowed to mean. */
  accountId: string | null;
  /** Stable per-installation id, minted once and never rotated afterwards —
   *  survives an unpair/re-pair, unlike the token. Sent to telemetry-svc as
   *  `deviceKey` so automatic provisioning can ask for "the token for THIS
   *  device" and get told "already have one" instead of minting a fresh
   *  secret on every launch. */
  deviceKey: string;
}

const EMPTY: ActivityAgentState = {
  version: 2,
  enabled: false, // OFF until the person says yes. Never opt-out.
  token: null,
  consentedVersion: null,
  accountId: null,
  deviceKey: randomUUID(),
};

/** Who the MAIN process currently believes is signed in, per the same
 *  `auth:token` channel index.ts already uses for notification filtering —
 *  NOT persisted. It must not survive a restart independent of the app's own
 *  session restore: if it did, a signed-out machine would report the last
 *  person's account as still bound the moment the process relaunches, before
 *  the renderer has said anything at all. */
let signedInAs: string | null = null;

let filePath = "";
let mem: ActivityAgentState = { ...EMPTY };
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    filePath = join(app.getPath("userData"), "activity-agent.json");
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ActivityAgentState>;
      mem = {
        version: 2,
        enabled: parsed.enabled === true,
        token: typeof parsed.token === "string" ? parsed.token : null,
        consentedVersion:
          typeof parsed.consentedVersion === "string" ? parsed.consentedVersion : null,
        accountId: typeof parsed.accountId === "string" ? parsed.accountId : null,
        // A file from before this field existed gets a fresh key, minted once
        // here and persisted immediately below — never regenerated again.
        deviceKey: typeof parsed.deviceKey === "string" && parsed.deviceKey ? parsed.deviceKey : randomUUID(),
      };
      if (parsed.deviceKey !== mem.deviceKey) flush();
    }
  } catch {
    // A corrupt file must not brick startup — and failing to OFF is the only
    // acceptable direction for a monitoring feature.
    mem = { ...EMPTY };
  }
}

/** Atomic temp→rename, matching sticky-state.ts: a SIGKILL mid-write leaves the
 *  previous good file rather than a truncated one that would read as "no
 *  consent recorded" and re-prompt. */
function flush(): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(mem), "utf8");
    renameSync(tmp, filePath);
  } catch {
    try {
      unlinkSync(filePath + ".tmp");
    } catch {
      /* nothing more to do */
    }
  }
}

export function getState(): ActivityAgentState {
  ensureLoaded();
  return { ...mem };
}

/** The stable per-installation id — see the field's own doc comment above. */
export function getDeviceKey(): string {
  ensureLoaded();
  return mem.deviceKey;
}

/**
 * Tell the agent who is signed in right now. The main process learns this
 * from the SAME `auth:token` IPC channel it already uses for notification
 * filtering (index.ts) — login, refresh and sign-out all funnel through it,
 * which makes it the one place that always knows the current account.
 *
 * Binds `accountId` to whoever asks FIRST without touching the existing
 * token/enabled — a state file with `accountId: null` is either a fresh
 * pairing or an upgrade from before this field existed, and an
 * already-consented single-user desktop must not lose its pairing on the
 * first post-upgrade login. Only a DIFFERENT already-bound account forces a
 * wipe: this is the fix for a shared machine silently continuing to
 * attribute activity to whoever paired it first after someone else signs in.
 *
 * `accountId: null` (signing out) intentionally does NOT wipe the pairing —
 * only `isActive()` goes false, immediately stopping the sampler without
 * discarding consent, so the SAME person signing back in a moment later does
 * not have to re-pair and re-consent.
 */
export function setSignedInAccount(accountId: string | null): ActivityAgentState {
  ensureLoaded();
  signedInAs = accountId;
  if (accountId === null) return { ...mem };
  if (mem.accountId !== null && mem.accountId !== accountId) {
    mem.token = null;
    mem.enabled = false;
  }
  if (mem.accountId !== accountId) {
    mem.accountId = accountId;
    flush();
  }
  return { ...mem };
}

/** True when the person has agreed AT THIS VERSION, a pairing token exists,
 *  AND the account currently signed in is the account this was paired
 *  for — see `setSignedInAccount`. */
export function isActive(): boolean {
  ensureLoaded();
  return (
    mem.enabled &&
    !!mem.token &&
    mem.consentedVersion === app.getVersion() &&
    signedInAs !== null &&
    signedInAs === mem.accountId
  );
}

export function setEnabled(enabled: boolean): ActivityAgentState {
  ensureLoaded();
  mem.enabled = enabled;
  if (enabled) mem.consentedVersion = app.getVersion();
  flush();
  return { ...mem };
}

export function setToken(token: string | null): ActivityAgentState {
  ensureLoaded();
  mem.token = token;
  // Unpairing is also a withdrawal of consent — leaving `enabled` true with no
  // token would put the UI in a state that claims to be sampling and is not.
  if (!token) mem.enabled = false;
  flush();
  return { ...mem };
}
