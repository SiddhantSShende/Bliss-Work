import { app, nativeImage, type NativeImage } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Path to the app icon PNG in both dev and packaged builds. In dev the main
 * bundle lives at out/main, so the icon is two levels up under build/. When
 * packaged it's copied into the app's resources dir via electron-builder's
 * `extraResources`.
 */
function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(here, "../../build/icon.png");
}

let cached: NativeImage | null = null;

/** Full-resolution app icon (window + dialogs). */
export function appIcon(): NativeImage {
  if (!cached) cached = nativeImage.createFromPath(iconPath());
  return cached;
}

/** Small icon for the system tray; Electron scales for hi-DPI. */
export function trayIcon(): NativeImage {
  const img = appIcon();
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}
