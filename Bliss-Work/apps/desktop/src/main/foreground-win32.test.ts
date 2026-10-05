import { describe, expect, it, vi } from "vitest";
import {
  bindForegroundNative,
  getForegroundApp,
  loadForegroundNative,
  type ForegroundNative,
} from "./foreground-win32";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function fakeNative(over: Partial<ForegroundNative> = {}): ForegroundNative {
  return { foregroundWindow: () => 0x10, processIdOf: () => 42, imagePathOf: () => CHROME, ...over };
}

describe("getForegroundApp", () => {
  it("returns the executable name and path, stamped with the caller's timestamp", async () => {
    const native = fakeNative();
    await expect(getForegroundApp(1_700_000_000_000, async () => native)).resolves.toEqual({
      name: "chrome.exe",
      path: CHROME,
      at: 1_700_000_000_000,
    });
  });

  it("returns only name, path and at — nothing that could carry content", async () => {
    const app = await getForegroundApp(1, async () => fakeNative());
    expect(Object.keys(app ?? {}).sort()).toEqual(["at", "name", "path"]);
  });

  it("is null when native bindings are unavailable", async () => {
    await expect(getForegroundApp(1, async () => null)).resolves.toBeNull();
  });

  it("is null when there is no foreground window, without asking for a process", async () => {
    const processIdOf = vi.fn();
    await expect(getForegroundApp(1, async () => fakeNative({ foregroundWindow: () => 0, processIdOf }))).resolves.toBeNull();
    expect(processIdOf).not.toHaveBeenCalled();
  });

  it("is null when the owning process cannot be determined", async () => {
    const imagePathOf = vi.fn();
    await expect(getForegroundApp(1, async () => fakeNative({ processIdOf: () => 0, imagePathOf }))).resolves.toBeNull();
    expect(imagePathOf).not.toHaveBeenCalled();
  });

  it("is null for an inaccessible (elevated) or already-exited process", async () => {
    await expect(getForegroundApp(1, async () => fakeNative({ imagePathOf: () => null }))).resolves.toBeNull();
  });

  it("never throws, whichever step fails", async () => {
    const boom = () => {
      throw new Error("native call rejected");
    };
    await expect(getForegroundApp(1, async () => fakeNative({ foregroundWindow: boom }))).resolves.toBeNull();
    await expect(getForegroundApp(1, async () => fakeNative({ processIdOf: boom }))).resolves.toBeNull();
    await expect(getForegroundApp(1, async () => fakeNative({ imagePathOf: boom }))).resolves.toBeNull();
    await expect(getForegroundApp(1, async () => Promise.reject(new Error("load failed")))).resolves.toBeNull();
  });
});

describe("loadForegroundNative", () => {
  it.skipIf(process.platform === "win32")("is a null no-op off Windows rather than a crash", async () => {
    await expect(loadForegroundNative()).resolves.toBeNull();
  });
});

/** A koffi stand-in that records every bound prototype and every call. */
function fakeKoffi(behaviour: {
  hwnd?: number;
  pid?: number;
  handle?: number;
  queryOk?: boolean;
  path?: string;
  queryThrows?: boolean;
}) {
  const b = { hwnd: 0x10, pid: 42, handle: 7, queryOk: true, path: CHROME, ...behaviour };
  const bound: string[] = [];
  const calls: string[] = [];
  const impls: Record<string, (...args: unknown[]) => unknown> = {
    GetForegroundWindow: () => b.hwnd,
    GetWindowThreadProcessId: (_hwnd, out) => {
      (out as number[])[0] = b.pid;
      return 1;
    },
    OpenProcess: (access, inherit, pid) => {
      calls.push(`OpenProcess(${String(access)},${String(inherit)},${String(pid)})`);
      return b.handle;
    },
    QueryFullProcessImageNameW: (handle, flags, buf, size) => {
      calls.push(`QueryFullProcessImageNameW(${String(handle)},${String(flags)})`);
      if (b.queryThrows) throw new Error("query exploded");
      if (!b.queryOk) return false;
      const units = buf as Uint16Array;
      for (let i = 0; i < b.path.length; i++) units[i] = b.path.charCodeAt(i);
      (size as number[])[0] = b.path.length;
      return true;
    },
    CloseHandle: (handle) => {
      calls.push(`CloseHandle(${String(handle)})`);
      return true;
    },
  };
  const koffi = {
    load: (lib: string) => ({
      func: (proto: string) => {
        bound.push(`${lib}:${proto}`);
        const name = /(\w+)\(/.exec(proto)?.[1] ?? "";
        const impl = impls[name];
        if (!impl) throw new Error(`unexpected binding ${name}`);
        return impl;
      },
    }),
  };
  return { koffi, bound, calls };
}

describe("bindForegroundNative", () => {
  it("binds exactly the five Win32 calls and nothing that could read content", () => {
    const { koffi, bound } = fakeKoffi({});
    bindForegroundNative(koffi);
    const names = bound.map((p) => /(\w+)\(/.exec(p)?.[1]).sort();
    expect(names).toEqual([
      "CloseHandle",
      "GetForegroundWindow",
      "GetWindowThreadProcessId",
      "OpenProcess",
      "QueryFullProcessImageNameW",
    ]);
    expect(bound.filter((p) => p.startsWith("user32.dll:")).length).toBe(2);
    expect(bound.filter((p) => p.startsWith("kernel32.dll:")).length).toBe(3);
  });

  it("resolves the full chain end to end, decoding the UTF-16 path", async () => {
    const { koffi, calls } = fakeKoffi({ path: "C:\\Приложения\\редактор.exe" });
    const native = bindForegroundNative(koffi);
    await expect(getForegroundApp(5, async () => native)).resolves.toEqual({
      name: "редактор.exe",
      path: "C:\\Приложения\\редактор.exe",
      at: 5,
    });
    // Limited-rights query, no inheritance, then the handle is released.
    expect(calls).toEqual(["OpenProcess(4096,false,42)", "QueryFullProcessImageNameW(7,0)", "CloseHandle(7)"]);
  });

  it("cuts the path at its NUL terminator if the length was not written back", async () => {
    const { koffi } = fakeKoffi({ path: CHROME });
    const real = koffi.load;
    // Leave the size at the full buffer, as if the _Inout_ write-back never happened.
    koffi.load = (lib: string) => {
      const lib_ = real(lib);
      return {
        func: (proto: string) => {
          const fn = lib_.func(proto);
          return proto.includes("QueryFullProcessImageNameW")
            ? (h: unknown, f: unknown, buf: unknown, size: unknown) => {
                const sizeBefore = (size as number[])[0];
                const ok = fn(h, f, buf, size);
                (size as number[])[0] = sizeBefore as number;
                return ok;
              }
            : fn;
        },
      };
    };
    await expect(getForegroundApp(1, async () => bindForegroundNative(koffi))).resolves.toMatchObject({
      name: "chrome.exe",
      path: CHROME,
    });
  });

  it("returns null and opens nothing when no window is in front", async () => {
    const { koffi, calls } = fakeKoffi({ hwnd: 0 });
    await expect(getForegroundApp(1, async () => bindForegroundNative(koffi))).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null for an inaccessible process (OpenProcess yields 0) with no handle to close", async () => {
    const { koffi, calls } = fakeKoffi({ handle: 0 });
    await expect(getForegroundApp(1, async () => bindForegroundNative(koffi))).resolves.toBeNull();
    expect(calls).toEqual(["OpenProcess(4096,false,42)"]);
  });

  it("closes the handle when the query reports failure (process exited mid-inspection)", async () => {
    const { koffi, calls } = fakeKoffi({ queryOk: false });
    await expect(getForegroundApp(1, async () => bindForegroundNative(koffi))).resolves.toBeNull();
    expect(calls.at(-1)).toBe("CloseHandle(7)");
  });

  it("closes the handle even when the query call throws", async () => {
    const { koffi, calls } = fakeKoffi({ queryThrows: true });
    await expect(getForegroundApp(1, async () => bindForegroundNative(koffi))).resolves.toBeNull();
    expect(calls.at(-1)).toBe("CloseHandle(7)");
  });

  it("throws at bind time if a function will not resolve (the loader turns that into null)", () => {
    const koffi = {
      load: () => ({
        func: () => {
          throw new Error("no such export");
        },
      }),
    };
    expect(() => bindForegroundNative(koffi)).toThrow("no such export");
  });
});
