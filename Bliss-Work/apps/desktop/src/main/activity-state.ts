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
 *   { version: 1, enabled: boolean, token: string|null, consentedVersion: string|null }
 *
 * `consentedVersion` is the app version at which the person last agreed. Users
 * never reinstall — the auto-updater replaces the app in place — so a
 * first-INSTALL prompt would mean this capability arriving silently on machines
 * that already had BlissWork. Keying consent to the version is what forces the
 * dialog to appear again when what is being sampled changes.
 */
export interface ActivityAgentState {
  version: 1;
  enabled: boolean;
  token: string | null;
  consentedVersion: string | null;
}

const EMPTY: ActivityAgentState = {
  version: 1,
  enabled: false, // OFF until the person says yes. Never opt-out.
  token: null,
  consentedVersion: null,
};

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
        version: 1,
        enabled: parsed.enabled === true,
        token: typeof parsed.token === "string" ? parsed.token : null,
        consentedVersion:
          typeof parsed.consentedVersion === "string" ? parsed.consentedVersion : null,
      };
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

/** True when the person has agreed AT THIS VERSION and a pairing token exists. */
export function isActive(): boolean {
  ensureLoaded();
  return mem.enabled && !!mem.token && mem.consentedVersion === app.getVersion();
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
