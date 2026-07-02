# Code-signing & notarization — BlissWork desktop

Your installers download fine; they're **blocked by the OS because they're
unsigned**. Windows SmartScreen / Smart App Control refuses executables without
a *verified publisher*, and macOS Gatekeeper refuses apps that aren't signed +
notarized. The ONLY way to make them install **without warnings** is a real,
paid code-signing certificate tied to your organization's identity.

electron-builder is already wired for this (see `apps/desktop/package.json` +
`build/notarize.cjs` + `build/entitlements.mac.plist`). **You don't change any
code** — you provide certificates via environment variables and rebuild.

---

## Windows — Authenticode certificate

### ⚠️ First: the "download a .pfx" era ended in June 2023
The CA/Browser Forum now requires the private key of every **publicly-trusted**
code-signing certificate (OV **and** EV) to live on certified hardware — a
FIPS 140-2 USB token or a cloud HSM. CAs no longer hand you a freely-exportable
`.pfx` for a new public cert, so you sign via one of three routes:

| Route | Cost | Key lives on | SmartScreen | Best for |
|-------|------|--------------|-------------|----------|
| **Azure Trusted Signing** ⭐ | ~$10 / month | Microsoft cloud HSM | Good; clears fast | Most teams — no hardware, cheapest, CI-friendly |
| **EV / OV on USB token** (DigiCert, Sectigo, SSL.com) | ~$200–600 / yr | Shipped USB token | EV = instant · OV = builds reputation | Teams OK plugging a token into a Windows box |
| **Cloud signing** (SSL.com eSigner, DigiCert KeyLocker) | ~$200–600 / yr | Vendor cloud HSM | same as their OV/EV | Token-free but not Azure |

> **Eligibility:** Azure Trusted Signing needs your org verified; organizations
> **younger than 3 years** must supply extra documentation. If AEIV Global can't
> verify yet, use SSL.com or Sectigo (token or cloud eSigner).

The repo's `CSC_LINK` + `.pfx` flow still works for a **self-signed test cert**
(see the bottom of this file) or any **legacy exportable `.pfx`** you already own:
```bash
export CSC_LINK="/absolute/path/to/blisswork-codesign.pfx"   # or base64 of the file
export CSC_KEY_PASSWORD="the-pfx-password"
cd apps/desktop && npm run build && npx electron-builder --win
```

### Route A — Azure Trusted Signing (recommended)
1. Azure Portal → create a **Trusted Signing account**, then a **Certificate
   profile** (this runs Microsoft's identity validation of AEIV Global).
2. Create an **App registration** (service principal); grant it the
   *Trusted Signing Certificate Profile Signer* role on the account.
3. Add the Azure signing block to `package.json` → `build.win` (keys stay in env,
   never here):
   ```jsonc
   "win": {
     "target": [{ "target": "nsis", "arch": ["x64"] }],
     "azureSignOptions": {
       "publisherName": "AEIV Global Private Limited",
       "endpoint": "https://eus.codesigning.azure.net",
       "codeSigningAccountName": "<your-trusted-signing-account>",
       "certificateProfileName": "<your-certificate-profile>"
     }
   }
   ```
4. Build **on Windows** with the service-principal creds in the environment:
   ```powershell
   $env:AZURE_TENANT_ID="…"; $env:AZURE_CLIENT_ID="…"; $env:AZURE_CLIENT_SECRET="…"
   cd apps\desktop; npm run build; npx electron-builder --win
   ```
   electron-builder pulls the cert from Azure and signs — no key ever hits disk.

### Route B — USB token (EV/OV) or cloud eSigner
The key can't be exported, so you sign on a **Windows** machine with the token
plugged in (or the vendor's cloud agent running):
1. Buy from DigiCert / Sectigo / SSL.com; pass org validation; receive the token
   (or eSigner cloud credentials).
2. Install the vendor's signing client + `signtool` (Windows SDK).
3. Add a custom `win.sign` hook to `build.win` that shells out to the vendor's
   `signtool` (they give the exact command), e.g. for a token thumbprint:
   ```powershell
   signtool sign /sha1 <THUMBPRINT> /tr http://timestamp.digicert.com /td sha256 /fd sha256 "$file"
   ```
4. `cd apps\desktop; npm run build; npx electron-builder --win` on that machine.

### Route C — SSL.com eSigner (⭐ recommended for AEIV: org < 3 yrs, no Azure)
Cloud HSM signing with **no USB token** and — because SSL.com's `CodeSignTool` is
cross-platform Java — you can sign the `.exe` **on the Linux VPS or in CI**, not
just Windows. Buy **EV** for instant SmartScreen trust (or OV to save money;
OV warns until reputation builds).
1. Buy an **EV Code Signing** cert at ssl.com and choose the **eSigner (cloud)**
   option. Complete org validation (company registration docs + a verification
   call; EV takes ~3–10 business days). No 3-year age rule.
2. In the SSL.com dashboard, enable eSigner and note: **username, password,
   credential ID, TOTP secret**.
3. Install CodeSignTool on the build host (`sudo apt install default-jre unzip`,
   then download+unzip CodeSignTool), OR use SSL.com's Docker image / the
   `sslcom/esigner-codesign` GitHub Action.
4. Turn on the ready-made hook — in `package.json` → `build.win` add:
   ```jsonc
   "sign": "build/sign-win.cjs"
   ```
   (and stop setting `CSC_LINK` — a custom `sign` replaces default signing).
5. Build with the eSigner creds in the env:
   ```bash
   export ES_USERNAME=…  ES_PASSWORD=…  ES_CREDENTIAL_ID=…  ES_TOTP_SECRET=…
   export CODE_SIGN_TOOL_PATH=/opt/CodeSignTool/CodeSignTool.sh
   cd apps/desktop && npm run build && npx electron-builder --win
   ```
   `build/sign-win.cjs` calls CodeSignTool per artifact; the cert never leaves
   SSL.com's HSM. (Verify the CodeSignTool flags against SSL.com's current docs —
   linked in that file.)

### Verify (any route)
```powershell
signtool verify /pa /v .\BlissWork-windows-x64.exe    # → "Successfully verified"
```
Then **regenerate `SHA256SUMS.txt`** (signed binaries have new hashes) and
re-upload the `.exe` + checksums to the VPS `downloads/` folder.

---

## macOS — Developer ID + notarization

### 1. Enroll + create certs
- Join the **Apple Developer Program** ($99/yr).
- Create a **Developer ID Application** certificate, export it as a `.p12`.
- Create an **app-specific password** at appleid.apple.com (for notarization),
  and note your **Team ID** (10 chars).

### 2. Sign + notarize (no code change — env only)
The mac block already sets `hardenedRuntime`, entitlements, and an `afterSign`
notarize hook that runs automatically when Apple creds are present:

```bash
export CSC_LINK="/absolute/path/to/DeveloperID-Application.p12"
export CSC_KEY_PASSWORD="the-p12-password"
export APPLE_ID="you@company.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="XXXXXXXXXX"
cd apps/desktop
npm run build && npx electron-builder --mac        # MUST run on a real Mac
```

(Or use an App Store Connect API key: `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`.)

> macOS installers can ONLY be built on macOS. The `.dmg` files currently in the
> download folder are placeholders — build them on a Mac with the above.

Verify:
```bash
codesign --verify --deep --strict --verbose=2 "BlissWork.app"
xcrun stapler validate "BlissWork-mac-arm64.dmg"
spctl -a -vvv -t install "BlissWork-mac-arm64.dmg"   # should say "accepted / Notarized Developer ID"
```

---

## Linux
No signing is needed to install. `.AppImage` just needs the execute bit
(`chmod +x`) + FUSE; `.deb` installs via `apt`/`dpkg`. (Optional: GPG-sign the
`.deb` for an apt repo, or add a detached signature to the AppImage.)

---

## Testing the pipeline without buying a cert (Windows)
Prove signing works end-to-end with a **self-signed** cert (still warns on other
machines — not for public release):

```bash
cd apps/desktop
bash build/gen-selfsigned-cert.sh "YourTestPassword"
CSC_LINK="$PWD/build/certs/blisswork-selfsigned.pfx" \
CSC_KEY_PASSWORD="YourTestPassword" \
npx electron-builder --win
```
Import `build/certs/blisswork-selfsigned.crt` into **Trusted Root** + **Trusted
Publishers** on a test PC (or push via GPO on a managed fleet) and it installs
without a warning **on those machines only**.

---

## CI (recommended)
Store the cert + passwords as encrypted secrets (never commit them — `build/certs/`
is git-ignored). In GitHub Actions set `CSC_LINK` (base64 of the `.pfx`),
`CSC_KEY_PASSWORD`, and the `APPLE_*` secrets, then run the package step. Windows
signing needs a Windows (or self-hosted token) runner; mac needs a macOS runner.
