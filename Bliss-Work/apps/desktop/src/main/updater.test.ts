/**
 * A downloaded-but-not-installed update stays "available" until the app restarts,
 * so the 3-minute background check announces it again every time — and each
 * announcement re-ran the integrity check and the (cached) download, which fires
 * "update-downloaded" again and popped the "Update ready" dialog once more. Someone
 * who had answered "Later" was asked again every three minutes, indefinitely.
 *
 * Runs the real updater module against the real event names; electron and
 * electron-updater (the OS and the network) are stand-ins.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  updater: null as unknown as EventEmitter & Record<string, unknown>, // set when electron-updater is (re)imported
  showMessageBox: vi.fn(),
  checkSecondSource: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0", on: vi.fn() },
  dialog: { showMessageBox: h.showMessageBox },
}));
vi.mock("electron-updater", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const updater = Object.assign(new Emitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => ({ updateInfo: { version: "1.0.0" } })),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  h.updater = updater as never;
  return { default: { autoUpdater: updater } };
});
vi.mock("./update-integrity", () => ({ checkSecondSource: h.checkSecondSource }));

const available = (version: string) =>
  h.updater.emit("update-available", { version, files: [{ url: `BlissWork-${version}.exe`, sha512: "x" }], path: "p", sha512: "x" });
const downloaded = (version: string) => h.updater.emit("update-downloaded", { version });
/** Let the async handlers (integrity check, then downloadUpdate) run to completion. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** One trip through the real sequence: the check finds it, it is fetched, the file lands. */
async function updateArrives(version: string) {
  available(version);
  await settle();
  downloaded(version);
  await settle();
}

const downloadUpdate = () => h.updater.downloadUpdate as ReturnType<typeof vi.fn>;
const checkForUpdates = () => h.updater.checkForUpdates as ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules(); // module state (which version was downloaded/prompted) must not leak between tests
  h.showMessageBox.mockReset().mockResolvedValue({ response: 1 }); // the user answers "Later"
  h.checkSecondSource.mockReset().mockResolvedValue({ verified: true });
  h.updater?.removeAllListeners();
});

async function freshUpdater() {
  const mod = await import("./updater");
  mod.initAutoUpdate(() => null);
  return mod;
}

describe("the restart prompt", () => {
  it("is shown once for a version, however many background checks re-announce it", async () => {
    await freshUpdater();
    await updateArrives("1.1.0");

    // Three more periodic checks: each re-announces it, and each (as electron-updater
    // does for a cached installer) would have re-fired update-downloaded.
    for (let i = 0; i < 3; i++) await updateArrives("1.1.0");

    expect(h.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or verify an already-downloaded version again", async () => {
    await freshUpdater();
    await updateArrives("1.1.0");
    downloadUpdate().mockClear();
    h.checkSecondSource.mockClear();

    available("1.1.0");
    await settle();

    expect(h.checkSecondSource).not.toHaveBeenCalled();
    expect(downloadUpdate()).not.toHaveBeenCalled();
  });

  it("is shown again for a NEWER version", async () => {
    await freshUpdater();
    await updateArrives("1.1.0");

    await updateArrives("1.2.0");

    expect(h.showMessageBox).toHaveBeenCalledTimes(2);
    expect(h.showMessageBox.mock.calls[1]![0].message).toContain("1.2.0");
  });

  it("restarts into the update when the user chooses Restart now", async () => {
    h.showMessageBox.mockResolvedValue({ response: 0 });
    await freshUpdater();

    await updateArrives("1.1.0");
    await settle();

    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe("Settings → Check for updates", () => {
  it("re-shows the prompt the user dismissed, because they asked", async () => {
    const { checkForUpdatesNow } = await freshUpdater();
    await updateArrives("1.1.0"); // shown once, answered "Later"
    checkForUpdates().mockResolvedValue({ updateInfo: { version: "1.1.0" } });

    const result = await checkForUpdatesNow();
    await settle();

    expect(result).toEqual({ status: "downloading", version: "1.1.0" });
    expect(h.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("still reports up to date when there is nothing newer", async () => {
    const { checkForUpdatesNow } = await freshUpdater();
    checkForUpdates().mockResolvedValue({ updateInfo: { version: "1.0.0" } });

    expect(await checkForUpdatesNow()).toEqual({ status: "up-to-date", version: "1.0.0" });
  });
});
