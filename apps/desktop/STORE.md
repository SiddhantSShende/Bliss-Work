# Microsoft Store submission — BlissWork desktop

How to get BlissWork into the Microsoft Store, using the pieces already wired
up in this repo:

- `package.json` → `build.appx` — static Store packaging config (brand color,
  publisher display name, tiles).
- `build/icon.svg` + `build/gen-appx-assets.sh` — renders the brand mark into
  every required package tile size (`build/appx/*.png`).
- `build/build-appx.sh` — local/CI build wrapper.
- `.github/workflows/store-release.yml` — CI job that builds the `.appx` on
  a Windows runner and uploads it as a downloadable artifact.
- `build/store-assets/README.md` — the Store *listing* assets (screenshots,
  description copy) you upload by hand in Partner Center.

electron-builder packages Windows Store apps as **`.appx`** (its `appx`
target) — Partner Center accepts `.appx` the same as `.msix`; there's no
separate "msix" electron-builder target to configure.

Unlike the direct-download installers in `SIGNING.md`, **you don't need to
buy a code-signing certificate for the Store** — Microsoft signs the package
itself during certification. This path is simpler than the direct-download
one for that reason.

---

## 1. Enroll + reserve the app name

1. Go to [partner.microsoft.com](https://partner.microsoft.com) and enroll
   in the developer program (one-time fee; can be waived/reduced for some
   account types — Partner Center shows current pricing).
2. **Apps and games → + Create a new app** → reserve the name "BlissWork"
   (or a close variant if taken).
3. Open the new app → **App identity**. Partner Center shows two values you
   need for everything below:
   - **Package/Identity/Name** → this is `STORE_IDENTITY_NAME` (looks like
     `AEIVGlobalPrivateLimited.BlissWork`)
   - **Package/Identity/Publisher** → this is `STORE_PUBLISHER_ID` (looks
     like `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`)

These are **public identifiers**, not secrets, but they're specific to your
Partner Center account and only exist after this step — that's why they
aren't hardcoded in `package.json` and are instead passed in at build time.

## 2. Build the .appx

### Locally (Windows or macOS only — see note below)
```bash
cd apps/desktop
export STORE_IDENTITY_NAME="AEIVGlobalPrivateLimited.BlissWork"   # from step 1
export STORE_PUBLISHER_ID="CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"  # from step 1
bash build/build-appx.sh
```
Output: `apps/desktop/release/BlissWork-*.appx`.

> electron-builder's `appx` target shells out to Windows Kits
> (`makeappx.exe`/`makepri.exe`), and only runs where Node reports
> `process.platform` as `win32` or `darwin` — **not Linux, not WSL**. If
> you're not on Windows/macOS, use CI instead (below).

### Via CI (recommended)
1. Add two repo secrets: **Settings → Secrets and variables → Actions**:
   - `STORE_IDENTITY_NAME`
   - `STORE_PUBLISHER_ID`
2. Run the workflow: **Actions → Store Release (Microsoft Store) → Run workflow**
   (or push a tag: `git tag store-v0.1.0 && git push origin store-v0.1.0`).
3. Download the `.appx` from the workflow run's **Artifacts** section.

## 3. Re-render brand assets (only if the logo changes)
```bash
cd apps/desktop
bash build/gen-appx-assets.sh   # requires rsvg-convert: sudo apt install librsvg2-bin
```
This regenerates `build/icon.png` and all of `build/appx/*.png` from
`build/icon.svg` (the same mark used on the website favicon). The PNGs are
committed so CI doesn't need `rsvg-convert` installed.

## 4. Prepare the Store listing
Follow `build/store-assets/README.md` to capture screenshots (Microsoft
requires at least one, 1366×768 or 1920×1080 — real UI, not mockups) and
pull together the description copy.

In Partner Center, fill in:
- **Properties**: category **Productivity**, support contact info.
- **Age ratings**: complete the ratings questionnaire (BlissWork should
  qualify for the lowest/no-rating tier).
- **Pricing and availability**: Free, pick your markets.
- **Store listings**: screenshots, short/full description
  (`build/store-assets/README.md` has starter copy).
- **Packages**: upload the `.appx` from step 2.

## 5. Submit for certification
**Submit for certification** in Partner Center. Microsoft's automated +
manual review usually takes 24–72 hours. Common rejection reasons to check
before submitting:
- App crashes on first launch on a clean Windows VM.
- Missing/broken privacy policy URL (BlissWork has one at
  `https://blisswork.rnrtechs.com` — verify the specific `/privacy` page
  exists before listing it).
- Placeholder-looking branding — already fixed here (the icon used to be
  electron-vite's default sample icon; `build/icon.svg` is now the real
  BlissWork mark).

## 6. After approval
- The Store handles updates: bump `version` in `package.json`, rebuild
  (steps 1–2 don't need repeating unless identity changes), and submit a new
  package as an update in Partner Center.
- Consider wiring `electronUpdaterAware: true` under `build.appx` later if
  you want in-app update checks to recognize Store-installed copies
  differently from direct-download ones — not set up here since this repo's
  direct-download builds already use their own updater path (see
  `SIGNING.md`).

---

## Optional: fully automated submission from CI

`store-release.yml` has a gated step using Microsoft's official
[`msstore-cli`](https://github.com/microsoft/msstore-cli) that pushes the
build straight into a **draft** Partner Center submission (never
auto-publishes — you still review + submit for certification by hand). It's
skipped entirely unless you set these secrets:

- `AZURE_STORE_TENANT_ID`, `AZURE_STORE_CLIENT_ID`, `AZURE_STORE_CLIENT_SECRET`
  — an Azure AD app registration associated with your Partner Center account
  (Partner Center → **Account settings → User management → Azure AD
  applications**, or **Tenant details**, depending on account type — grant
  it the Store API's "Manage app metadata" scope).
- `STORE_APP_ID` — Partner Center → your app → **App identity → Store ID**.

This is worth setting up only once you're submitting updates regularly;
skip it for the first submission and just upload the `.appx` by hand.
