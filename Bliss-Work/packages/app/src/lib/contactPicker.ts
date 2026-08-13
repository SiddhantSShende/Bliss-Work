/**
 * The Web Contact Picker, and an honest account of where it exists.
 *
 * `navigator.contacts` is Chrome-on-Android only. Desktop Chrome and Edge do
 * not have it, Firefox and Safari do not have it, iOS does not have it, and the
 * Electron renderer does not have it. So for very nearly every user of this app
 * the manual form is the only path — which is why the picker is a button ABOVE
 * that form rather than a mode the UI switches into, and why nothing here
 * throws when it is missing.
 */

interface ContactsManager {
  select(
    props: string[],
    opts?: { multiple?: boolean },
  ): Promise<Array<{ name?: string[]; tel?: string[] }>>;
}

/**
 * The picker, or null when this environment has none.
 *
 * The secure-context check is necessary but not sufficient — Chromium treats
 * `file://` as potentially trustworthy, so a packaged Electron renderer passes
 * it. The `select` presence test is what actually decides.
 */
export function contactsPicker(): ContactsManager | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  if (!window.isSecureContext) return null;
  const n = navigator as Navigator & { contacts?: ContactsManager };
  return typeof n.contacts?.select === "function" ? n.contacts : null;
}

/**
 * Open the picker and return the chosen contact, or null if it was cancelled or
 * unavailable.
 *
 * MUST be called synchronously from a click handler: `select()` requires
 * transient user activation and consumes it. That is also why this returns the
 * contact instead of doing anything with it — the caller needs a fresh gesture
 * for whatever comes next.
 *
 * A rejection here is the ordinary cancel path, not an error worth surfacing.
 */
export async function pickContact(
  picker: ContactsManager | null,
): Promise<{ name: string; phone: string } | null> {
  if (!picker) return null;
  try {
    const [c] = await picker.select(["name", "tel"], { multiple: false });
    if (!c) return null;
    return { name: c.name?.[0] ?? "", phone: c.tel?.[0] ?? "" };
  } catch {
    return null;
  }
}
