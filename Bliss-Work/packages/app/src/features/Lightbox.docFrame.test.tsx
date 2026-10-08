/**
 * The in-app PDF / plain-text preview renders fetched bytes in an <iframe> off a
 * `blob:` URL — which inherits the app's origin. So the bytes are re-labelled as
 * the one type the viewer chose to render (a response saying text/html must not
 * become an HTML document), plain text is sandboxed, the download is aborted on
 * close, and a failure shows localised copy rather than a raw English message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Lightbox } from "./Lightbox";
import type { MediaItem } from "../lib/chatEnvelope";

const item = (mime: string, name = "file"): MediaItem => ({ id: "a1", name, size: 10, mime });
const mount = (media: MediaItem) =>
  render(<Lightbox items={[media]} index={0} urlFor={() => "https://files.test/a1?sig=1"} onClose={() => {}} onIndexChange={() => {}} />);

let created: Blob[];
let signals: AbortSignal[];

beforeEach(() => {
  created = [];
  signals = [];
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: (b: Blob) => {
      created.push(b);
      return "blob:app/1";
    },
    revokeObjectURL: vi.fn(),
  }));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal) signals.push(init.signal);
    // A hostile / mislabelled response.
    return { ok: true, status: 200, blob: async () => new Blob(["<script>alert(1)</script>"], { type: "text/html" }) };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Lightbox document frame", () => {
  it("re-labels a PDF as application/pdf whatever the response said", async () => {
    const { container } = mount(item("application/pdf", "a.pdf"));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(created[0]!.type).toBe("application/pdf");
    // Chromium's PDF viewer will not run in a sandboxed frame.
    expect(container.querySelector("iframe")!.hasAttribute("sandbox")).toBe(false);
  });

  it("re-labels plain text as text/plain and sandboxes it with no permissions", async () => {
    const { container } = mount(item("text/plain", "a.txt"));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(created[0]!.type).toBe("text/plain;charset=utf-8");
    expect(container.querySelector("iframe")!.getAttribute("sandbox")).toBe("");
  });

  it("aborts the download when the preview is closed mid-flight", async () => {
    const { unmount } = mount(item("application/pdf", "a.pdf"));
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it("shows localised copy, not the raw error, when the fetch fails", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ ok: false, status: 403, blob: async () => new Blob([]) }));
    mount(item("application/pdf", "a.pdf"));
    expect(await screen.findByText("This document can't be previewed.")).toBeTruthy();
    expect(screen.queryByText(/Preview failed to load/)).toBeNull();
  });
});
