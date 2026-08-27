import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Account binding for the desktop activity agent — the fix for a real gap:
 * nothing previously recorded WHICH BlissWork account a pairing belonged to,
 * so on a shared machine, signing out and a different person signing in left
 * the sampler quietly attributing their activity to whoever paired it first.
 *
 * Exercises the real module against a real temp file (not a mock of fs) —
 * this file's own crash-safety (atomic temp-then-rename writes) is part of
 * what is being trusted here.
 */

let userDataDir: string;
let appVersion = "1.0.0";

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userDataDir : "/tmp"),
    getVersion: () => appVersion,
  },
}));

async function freshModule() {
  vi.resetModules();
  return import("./activity-state");
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), "activity-state-test-"));
  appVersion = "1.0.0";
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("activity-state: account binding", () => {
  it("starts unpaired, off, and unbound", async () => {
    const state = await freshModule();
    const s = state.getState();
    expect(s.enabled).toBe(false);
    expect(s.token).toBeNull();
    expect(s.accountId).toBeNull();
    expect(state.isActive()).toBe(false);
  });

  it("a fresh installation's deviceKey is stable across reloads of the same file", async () => {
    const first = await freshModule();
    first.setToken("t"); // forces a flush so the generated deviceKey is persisted
    const key1 = first.getDeviceKey();

    const second = await freshModule();
    expect(second.getDeviceKey()).toBe(key1);
  });

  it("binds accountId to whoever signs in first, without disturbing token/enabled", async () => {
    const state = await freshModule();
    state.setToken("pairing-token");
    state.setEnabled(true);
    state.setSignedInAccount("user-a");

    const s = state.getState();
    expect(s.accountId).toBe("user-a");
    expect(s.token).toBe("pairing-token");
    expect(s.enabled).toBe(true);
    expect(state.isActive()).toBe(true);
  });

  it("preserves an existing pairing when the SAME account signs in again", async () => {
    const state = await freshModule();
    state.setToken("pairing-token");
    state.setEnabled(true);
    state.setSignedInAccount("user-a");
    state.setSignedInAccount(null); // sign out
    state.setSignedInAccount("user-a"); // sign back in

    const s = state.getState();
    expect(s.token).toBe("pairing-token");
    expect(s.enabled).toBe(true);
    expect(state.isActive()).toBe(true);
  });

  it("an upgrade from before accountId existed binds to the first signed-in user without wiping the pairing", async () => {
    // Simulate a pre-upgrade v1 file: enabled+token, no accountId/deviceKey.
    const first = await freshModule();
    first.setToken("legacy-token");
    first.setEnabled(true);

    const upgraded = await freshModule();
    upgraded.setSignedInAccount("user-a");

    const s = upgraded.getState();
    expect(s.token).toBe("legacy-token");
    expect(s.enabled).toBe(true);
    expect(upgraded.isActive()).toBe(true);
  });

  it("wipes the pairing and consent when a DIFFERENT account signs in — the account-switch fix", async () => {
    const state = await freshModule();
    state.setToken("user-a-token");
    state.setEnabled(true);
    state.setSignedInAccount("user-a");
    expect(state.isActive()).toBe(true);

    state.setSignedInAccount(null); // user A signs out
    state.setSignedInAccount("user-b"); // user B signs in on the same machine

    const s = state.getState();
    expect(s.token).toBeNull();
    expect(s.enabled).toBe(false);
    expect(s.accountId).toBe("user-b");
    expect(state.isActive()).toBe(false);
  });

  it("is inactive while signed out even though enabled and token both remain true — the logout fix", async () => {
    const state = await freshModule();
    state.setToken("t");
    state.setEnabled(true);
    state.setSignedInAccount("user-a");
    expect(state.isActive()).toBe(true);

    state.setSignedInAccount(null);

    const s = state.getState();
    expect(s.enabled).toBe(true); // consent itself is not withdrawn by sign-out
    expect(s.token).toBe("t"); // nor is the pairing
    expect(state.isActive()).toBe(false); // but nothing samples while signed out
  });

  it("does not report active when the consented app version has moved on", async () => {
    const state = await freshModule();
    state.setToken("t");
    state.setEnabled(true);
    state.setSignedInAccount("user-a");
    appVersion = "2.0.0";
    expect(state.isActive()).toBe(false);
  });

  it("persists accountId to disk so a relaunch under the same account stays bound", async () => {
    const first = await freshModule();
    first.setToken("t");
    first.setEnabled(true);
    first.setSignedInAccount("user-a");

    const raw = JSON.parse(readFileSync(join(userDataDir, "activity-agent.json"), "utf8"));
    expect(raw.accountId).toBe("user-a");

    const relaunched = await freshModule();
    relaunched.setSignedInAccount("user-a");
    expect(relaunched.isActive()).toBe(true);
  });
});
