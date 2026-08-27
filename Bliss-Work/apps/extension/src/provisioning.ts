/**
 * Verify a pairing token actually works, then store it.
 *
 * Shared by the two ways a person connects this extension: pasting a
 * connection code (options.ts) and the automatic externally_connectable
 * handoff from a signed-in BlissWork tab (background.ts) — so both trust an
 * incoming token identically. Saving one unverified would leave the
 * extension looking connected while silently 401ing on every batch, which is
 * the worst of both worlds: it records nothing and says it is fine.
 *
 * Stores `paused: true` — provisioning is not consent, the same rule the
 * desktop app's activity-state.ts enforces for its own pairing. The person
 * still has to click Resume, here or in this extension's own options page,
 * before anything is actually recorded.
 */
export type ProvisionResult =
  | { ok: true }
  | { ok: false; reason: "bad-request" | "invalid-token" | "unreachable" };

export async function provisionToken(token: string, apiBase: string): Promise<ProvisionResult> {
  if (!token || !apiBase) return { ok: false, reason: "bad-request" };
  try {
    const res = await fetch(`${apiBase}/telemetry/ingest/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Ingest-Token": token },
      body: JSON.stringify({ events: [] }),
    });
    if (res.status === 401) return { ok: false, reason: "invalid-token" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  await chrome.storage.local.set({ token, apiBase, paused: true });
  return { ok: true };
}
