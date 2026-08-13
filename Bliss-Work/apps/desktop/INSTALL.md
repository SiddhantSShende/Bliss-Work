# Installing BlissWork

Until the app is code-signed (see `SIGNING.md`), your operating system will warn
that the publisher is "unknown." The app is safe — verify the download with the
published **SHA-256 checksum**, then follow the steps for your OS.

## Verify your download (recommended, all platforms)
Compare your file's hash against `SHA256SUMS.txt` (served next to the installers,
e.g. `https://blisswork.rnrtechs.com/downloads/SHA256SUMS.txt`).

- **Windows (PowerShell):** `Get-FileHash .\BlissWork-windows-x64.exe -Algorithm SHA256`
- **macOS:** `shasum -a 256 BlissWork-mac-arm64.dmg`
- **Linux:** `sha256sum BlissWork-linux-x64.AppImage`

If the hash matches the one in `SHA256SUMS.txt`, the file is authentic.

---

## Windows 10 / 11
1. Run `BlissWork-windows-x64.exe`.
2. On the blue **"Windows protected your PC"** screen, click **More info** →
   **Run anyway**.
3. If **Smart App Control** blocks it outright (newer/clean Windows 11): right-click
   the `.exe` → **Properties** → tick **Unblock** → **OK**, then run it again.
   (Smart App Control fully clears only once the app is signed — see `SIGNING.md`.)

## macOS 11+
> The `.dmg` is built on a macOS CI runner by `release.yml` — real, but unsigned
> and un-notarized until certificates are in place, so expect Gatekeeper to object.
1. Open the `.dmg`, drag **BlissWork** to **Applications**.
2. First launch: **Control-click** (right-click) the app in Applications → **Open**
   → **Open** in the dialog. (Double-clicking is blocked for unsigned apps.)
3. If it says *"is damaged / can't be opened"*, clear the quarantine flag:
   ```bash
   xattr -dr com.apple.quarantine /Applications/BlissWork.app
   ```
   (A signed + notarized build removes this step entirely — see `SIGNING.md`.)

## Linux
**AppImage (any distro):**
```bash
chmod +x BlissWork-linux-x64.AppImage
./BlissWork-linux-x64.AppImage
```
If it complains about FUSE: `sudo apt install libfuse2` (Debian/Ubuntu) or your
distro's equivalent, or run with `--appimage-extract-and-run`.

**Debian / Ubuntu (.deb):**
```bash
sudo apt install ./BlissWork-linux-x64.deb
# or:  sudo dpkg -i BlissWork-linux-x64.deb && sudo apt -f install
```
Then launch **BlissWork** from your app menu.
