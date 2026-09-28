import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const setClipboardApi = (writeText: ((text: string) => Promise<void>) | undefined) => {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
};

// jsdom does not implement execCommand at all, so vi.spyOn (which requires the
// property to already exist) can't be used — assign a fresh mock instead.
const setExecCommand = (result: boolean) => {
  const fn = vi.fn().mockReturnValue(result);
  (document as unknown as { execCommand: typeof fn }).execCommand = fn;
  return fn;
};

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

describe("copyText", () => {
  it("writes through navigator.clipboard when it succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboardApi(writeText);

    await expect(copyText("code1\ncode2\ncode3")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("code1\ncode2\ncode3");
  });

  it("falls back to execCommand when the Clipboard API rejects (e.g. permission denied)", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    setClipboardApi(writeText);
    const execCommand = setExecCommand(true);

    await expect(copyText("https://example.test/join/abc")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand when navigator.clipboard is entirely absent", async () => {
    setClipboardApi(undefined);
    const execCommand = setExecCommand(true);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure only when both paths genuinely fail", async () => {
    setClipboardApi(undefined);
    setExecCommand(false);

    await expect(copyText("hello")).resolves.toBe(false);
  });

  it("does not alter the copied text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboardApi(writeText);

    const codes = ["ABCD-1234", "EFGH-5678", "IJKL-9012"].join("\n");
    await copyText(codes);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(codes);
  });

  it("removes the fallback textarea from the DOM after use", async () => {
    setClipboardApi(undefined);
    setExecCommand(true);

    await copyText("hello");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
