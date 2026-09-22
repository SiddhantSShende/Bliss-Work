import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: h.toastError } }));

import {
  hasOutsideOpen,
  openAttachmentNatively,
  openOutsideApp,
  opensInBrowser,
  opensNatively,
} from "./openAttachment";

const desktop = { kind: "electron" as const, openAttachment: vi.fn() };
const desktopSubWindow = { kind: "electron" as const };
const web = { kind: "web" as const };
const mobile = { kind: "mobile" as const };
const URL_ = "https://m.test/media/a1?t=tok";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

let windowOpen: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.toastError.mockReset();
  desktop.openAttachment.mockReset();
  windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("opensNatively", () => {
  it.each([
    ["a PowerPoint deck", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["a Word document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["a zip", "application/zip"],
    ["an unknown type", "application/octet-stream"],
  ])("desktop hands %s to its native app", (_label, mime) => {
    expect(opensNatively(desktop, mime)).toBe(true);
  });

  it.each([
    ["an image", "image/png"],
    ["a video", "video/mp4"],
    ["a PDF", "application/pdf"],
    ["plain text", "text/plain"],
  ])("desktop keeps %s in the in-app viewer", (_label, mime) => {
    expect(opensNatively(desktop, mime)).toBe(false);
  });

  it("is never true without a desktop host (web, mobile)", () => {
    expect(opensNatively(web, "application/zip")).toBe(false);
    expect(opensNatively(web, "application/vnd.ms-powerpoint")).toBe(false);
  });
});

describe("openAttachmentNatively", () => {
  it("passes the signed URL and file name to the host's openAttachment", async () => {
    desktop.openAttachment.mockResolvedValue({ ok: true });

    await openAttachmentNatively(desktop, "https://m.test/media/a1?t=tok", "Deck.pptx");

    expect(desktop.openAttachment).toHaveBeenCalledExactlyOnceWith("https://m.test/media/a1?t=tok", "Deck.pptx");
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("tells the user when the host could not open it", async () => {
    desktop.openAttachment.mockResolvedValue({ ok: false, error: "No application is associated" });

    await openAttachmentNatively(desktop, "https://m.test/media/a1?t=tok", "Deck.pptx");

    expect(h.toastError).toHaveBeenCalledWith("Could not open Deck.pptx", {
      description: "No application is associated",
    });
  });
});

describe("opensInBrowser", () => {
  it.each(["application/zip", PPTX, "application/octet-stream"])("web points the browser at %s", (mime) => {
    expect(opensInBrowser(web, mime)).toBe(true);
  });

  it.each(["image/png", "video/mp4", "application/pdf", "text/plain"])("web keeps %s in the in-app viewer", (mime) => {
    expect(opensInBrowser(web, mime)).toBe(false);
  });

  it("is web only: desktop, its other windows and mobile are never sent to a browser tab", () => {
    for (const host of [desktop, desktopSubWindow, mobile]) {
      expect(opensInBrowser(host, "application/zip")).toBe(false);
    }
  });
});

describe("hasOutsideOpen", () => {
  it("is true for web and for a desktop window with the host call, false otherwise", () => {
    expect(hasOutsideOpen(web)).toBe(true);
    expect(hasOutsideOpen(desktop)).toBe(true);
    expect(hasOutsideOpen(desktopSubWindow)).toBe(false);
    expect(hasOutsideOpen(mobile)).toBe(false);
  });
});

describe("openOutsideApp", () => {
  it("web: opens a new tab on the signed URL with no opener, and reports it handled", () => {
    expect(openOutsideApp(web, PPTX, URL_, "Deck.pptx")).toBe(true);
    expect(windowOpen).toHaveBeenCalledExactlyOnceWith(URL_, "_blank", "noopener,noreferrer");
  });

  it("desktop: uses the host and never a browser tab", () => {
    desktop.openAttachment.mockResolvedValue({ ok: true });
    expect(openOutsideApp(desktop, PPTX, URL_, "Deck.pptx")).toBe(true);
    expect(desktop.openAttachment).toHaveBeenCalledExactlyOnceWith(URL_, "Deck.pptx");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it.each([
    ["web image", web, "image/png"],
    ["web PDF", web, "application/pdf"],
    ["web text", web, "text/plain"],
    ["web video", web, "video/mp4"],
    ["desktop PDF", desktop, "application/pdf"],
    ["desktop's other window", desktopSubWindow, PPTX],
    ["mobile", mobile, PPTX],
  ])("%s: does nothing and reports not handled, so the Lightbox opens", (_l, host, mime) => {
    expect(openOutsideApp(host, mime, URL_, "f")).toBe(false);
    expect(windowOpen).not.toHaveBeenCalled();
    expect(desktop.openAttachment).not.toHaveBeenCalled();
  });
});
