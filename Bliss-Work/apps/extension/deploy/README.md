# Fleet deployment — force-install + enrolment

How the BlissWork Activity extension reaches a whole team's browsers and reports
without anyone pasting a code. Self-hosted CRX + enterprise policy — no Chrome
Web Store round-trip (which is slow and can reject a browsing reporter).

## What this deploys

The **protected default** configuration: full-URL capture of ordinary sites and
off-task time, with the sensitive-category floor (health, banking, government,
legal aid, job hunting) and incognito **on**. Disclosed — Chrome shows "Installed
by your organization", and it must be in your employee terms.

Two things this deployment path deliberately **cannot** do:

- **It can't push comprehensive capture to the fleet.** `captureAll` and
  `captureIncognito` are not in `managed-schema.json`, so no policy can switch off
  the category floor or start recording private windows across managed browsers.
  Turning those on is a per-device change, by design.
- **It's not hidden.** The "Installed by your organization" banner stays. Do not
  attempt to suppress it — a monitor the person can't see is a different thing,
  legally and ethically.

## Steps

1. **Build.**
   ```
   npm run build -w @taskboard/extension     # -> apps/extension/dist
   ```
2. **Pack a signed CRX** (mints and reuses a stable key → stable extension ID):
   ```
   CODEBASE_URL=https://cdn.example.com/blisswork-activity.crx \
     bash apps/extension/scripts/pack-crx.sh
   ```
   Back up the printed key (`blisswork-extension.pem`) — the ID depends on it.
3. **Host** `dist.crx` and `deploy/updates.xml` at your CDN.
4. **Force-install by policy** — `deploy/chrome-policy.json` (Linux/macOS via MDM)
   or `deploy/windows-forcelist.reg` (Windows/Intune/GPO). Pin the extension ID
   from step 2 and the update URL from step 3.
5. **Enrol each member.** Provision a **per-user** ingest token through the same
   managed policy (`3rdparty` managed storage). Each token is one `(org, user)` —
   deliver a different one to each user's managed profile, or everyone's browsing
   is attributed to one person. Tokens are minted per member and revocable in
   BlissWork (Settings → Your activity), and revoke automatically when a
   membership ends.

## Before you enable it

- The **privacy policy and DPA** must describe browser-activity capture, and your
  **employee terms** must disclose it. Force-install does not substitute for
  disclosure.
- **Local law governs whether this is permissible at all.** Managed-device
  monitoring with notice is lawful in many places and not in others; special
  categories (health, finance) carry a higher bar that a terms clause does not by
  itself clear. That is a decision for you and counsel, not this README.
