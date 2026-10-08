import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dir: "",
  handlers: new Map<string, (...a: any[]) => any>(),
  free: Number.MAX_SAFE_INTEGER,
  streams: [] as import("node:fs").WriteStream[],
}));

vi.mock("electron", () => ({
  app: { getPath: () => h.dir },
  ipcMain: {
    handle: (ch: string, fn: (...a: any[]) => any) => h.handlers.set(ch, fn),
    on: (ch: string, fn: (...a: any[]) => any) => h.handlers.set(ch, fn),
  },
  shell: { showItemInFolder: vi.fn() },
}));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (...a: Parameters<typeof actual.createWriteStream>) => {
      const st = actual.createWriteStream(...a);
      h.streams.push(st);
      return st;
    },
  };
});
vi.mock("./i18n", () => ({ mainT: (k: string) => k }));
vi.mock("node:fs/promises", async (orig) => ({
  ...(await orig<typeof import("node:fs/promises")>()),
  statfs: async () => ({ bavail: h.free, bsize: 1 }),
}));

import { MAX_SINK_BYTES, registerFileSink } from "./file-sink";

const sender = {};
const ev = { sender };
const win = { webContents: sender } as never;
registerFileSink(() => win);
// async so a synchronous throw becomes a rejection, as ipcMain.handle does.
const call = async (ch: string, arg: unknown) => h.handlers.get(ch)!(ev, arg);

const roots: string[] = [];
beforeEach(() => {
  h.dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "filesink-"));
  roots.push(h.dir);
  h.free = Number.MAX_SAFE_INTEGER;
});
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("filesink:open", () => {
  it("sanitises the peer's file name with the shared sanitiser (ADS colon, trailing dot, device name)", async () => {
    await call("filesink:open", { id: "a", fileName: "photo.jpg:evil.exe.", size: 1 });
    await call("filesink:open", { id: "b", fileName: "con.txt", size: 1 });
    expect(existsSync(join(h.dir, "photo.jpg_evil.exe"))).toBe(true);
    expect(existsSync(join(h.dir, "_con.txt"))).toBe(true);
    call("filesink:abort", { id: "a" });
    call("filesink:abort", { id: "b" });
  });

  it.each([MAX_SINK_BYTES + 1, 1e15, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses size %s and creates nothing",
    async (size) => {
      await expect(call("filesink:open", { id: "x", fileName: "f.bin", size })).rejects.toThrow(/size/);
      expect(existsSync(join(h.dir, "f.bin"))).toBe(false);
    },
  );

  it("refuses a size larger than the free disk space", async () => {
    h.free = 1000;
    await expect(call("filesink:open", { id: "x", fileName: "f.bin", size: 1001 })).rejects.toThrow(/disk/);
    expect(existsSync(join(h.dir, "f.bin"))).toBe(false);
  });

  it("never overwrites an existing file: takes the next free name", async () => {
    writeFileSync(join(h.dir, "f.bin"), "precious");
    await call("filesink:open", { id: "x", fileName: "f.bin", size: 3 });
    expect(readFileSync(join(h.dir, "f.bin"), "utf8")).toBe("precious");
    expect(existsSync(join(h.dir, "f (1).bin"))).toBe(true);
    call("filesink:abort", { id: "x" });
    expect(readFileSync(join(h.dir, "f.bin"), "utf8")).toBe("precious");
  });

  it("still receives, verifies and keeps a normal transfer", async () => {
    const data = Buffer.from("hello world");
    await call("filesink:open", { id: "ok", fileName: "hello.txt", size: data.length });
    await call("filesink:write", { id: "ok", data: data.buffer.slice(data.byteOffset, data.byteOffset + data.length) });
    await expect(call("filesink:finish", { id: "ok", expectedSha256: sha(data) })).resolves.toBe(true);
    expect(readFileSync(join(h.dir, "hello.txt"), "utf8")).toBe("hello world");
  });
});

describe("stream errors", () => {
  it("survives a stream error (no uncaughtException) and fails the next write and the finish", async () => {
    await call("filesink:open", { id: "e", fileName: "e.bin", size: 10 });
    const stream = h.streams[h.streams.length - 1]!;
    // Unlistened, this async "error" is an uncaughtException — the crash being fixed
    // (vitest reports it as an unhandled error and fails the run).
    const closed = new Promise<void>((r) => stream.once("close", () => r()));
    stream.destroy(new Error("EIO"));
    await closed;
    const data = Buffer.from("x");
    await expect(call("filesink:write", { id: "e", data: new Uint8Array(data).buffer })).rejects.toThrow("EIO");
    await expect(call("filesink:finish", { id: "e", expectedSha256: sha(data) })).resolves.toBe(false);
    expect(existsSync(join(h.dir, "e.bin"))).toBe(false);
  });
});
