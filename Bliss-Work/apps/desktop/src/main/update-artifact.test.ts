import { describe, expect, it } from "vitest";
import { pickDownloadedFile } from "./update-artifact";

const f = (url: string) => ({ url, sha512: url });
const MAC = [
  f("BlissWork-mac-x64.dmg"),
  f("BlissWork-mac-x64.zip"),
  f("BlissWork-mac-arm64.dmg"),
  f("BlissWork-mac-arm64.zip"),
];

describe("pickDownloadedFile", () => {
  it("macOS arm64 gets the arm64 zip, not files[0] (the x64 dmg)", () => {
    expect(pickDownloadedFile(MAC, "darwin", "arm64")?.url).toBe("BlissWork-mac-arm64.zip");
  });

  it("macOS x64 gets the x64 zip", () => {
    expect(pickDownloadedFile(MAC, "darwin", "x64")?.url).toBe("BlissWork-mac-x64.zip");
  });

  it("Windows gets the exe, ignoring blockmaps", () => {
    const files = [f("BlissWork-windows-x64.exe.blockmap"), f("BlissWork-windows-x64.exe")];
    expect(pickDownloadedFile(files, "win32", "x64")?.url).toBe("BlissWork-windows-x64.exe");
  });

  it("Linux gets the AppImage, not the deb", () => {
    const files = [f("BlissWork-linux-x64.deb"), f("BlissWork-linux-x64.AppImage")];
    expect(pickDownloadedFile(files, "linux", "x64")?.url).toBe("BlissWork-linux-x64.AppImage");
  });

  it("accepts a single universal installer that names no architecture", () => {
    expect(pickDownloadedFile([f("BlissWork.exe")], "win32", "arm64")?.url).toBe("BlissWork.exe");
  });

  it("reads x86_64 / aarch64 spellings", () => {
    const files = [f("app-x86_64.AppImage"), f("app-aarch64.AppImage")];
    expect(pickDownloadedFile(files, "linux", "x64")?.url).toBe("app-x86_64.AppImage");
    expect(pickDownloadedFile(files, "linux", "arm64")?.url).toBe("app-aarch64.AppImage");
  });

  it.each([
    ["no entry for the platform", [f("BlissWork-windows-x64.exe")], "linux", "x64"],
    ["only another architecture", [f("BlissWork-windows-x64.exe")], "win32", "arm64"],
    ["two matching entries (ambiguous)", [f("a-x64.exe"), f("b-x64.exe")], "win32", "x64"],
    ["an unsupported platform", [f("BlissWork-freebsd-x64.pkg")], "freebsd", "x64"],
    ["an empty list", [], "win32", "x64"],
  ] as const)("returns null for %s, so the caller fails closed", (_n, files, platform, arch) => {
    expect(pickDownloadedFile(files, platform as NodeJS.Platform, arch)).toBeNull();
  });
});
