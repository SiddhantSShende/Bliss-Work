import { app, nativeImage, type NativeImage } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Path to the app icon PNG in both dev and packaged builds.
 *
 * Master source is `build/icon.svg`; every raster (icon.png, icon.ico,
 * icon.icns, the AppX tiles) is DERIVED from it by build/gen-desktop-icons.sh
 * and build/gen-appx-assets.sh.
 *
 * Do NOT copy `/assets/logo.png` over `build/icon.png`. That file is 257×237 and
 * not square; electron-builder requires ≥256×256 square and the result is an
 * invalid icon. Older versions of scripts/setup-branding.sh and BRANDING.md
 * both instructed exactly that — they now render from the SVG instead.
 *
 * In dev the main bundle lives at out/main, so the icon is read from
 * build/icon.png directly. When packaged it is copied into the app's resources
 * dir via electron-builder's `extraResources`.
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

/**
 * Small icon for the system tray.
 *
 * Downscaling 1024×1024 straight to 16×16 with the default filter turns the
 * mark's thin details — the bubble tail and the three dots — into mush, which
 * is exactly the size the user sees most. `quality: "best"` costs a few ms once
 * at startup and is the difference between a recognisable mark and a smudge.
 *
 * The 16px base plus a 32px @2x representation covers standard and hi-DPI
 * displays; without the 2x rep the OS upscales the 16px bitmap on a retina or
 * 150%-scaled screen and it looks soft.
 */
let trayCached: NativeImage | null = null;

export function trayIcon(): NativeImage {
  if (trayCached) return trayCached;
  const img = appIcon();
  if (img.isEmpty()) return img; // missing asset — let Electron show its default

  const base = img.resize({ width: 16, height: 16, quality: "best" });
  base.addRepresentation({
    scaleFactor: 2,
    width: 32,
    height: 32,
    buffer: img.resize({ width: 32, height: 32, quality: "best" }).toPNG(),
  });
  trayCached = base;
  return trayCached;
}
