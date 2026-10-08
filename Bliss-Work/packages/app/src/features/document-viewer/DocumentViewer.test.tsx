/**
 * The in-app document viewer, driven the way the server drives it: a mocked
 * `fetch` that answers 200 / 202 / 4xx / 5xx for `{signed url}/preview`, or serves
 * the file itself (CSV, text). The viewer renders real components; only `fetch`
 * and the object-URL functions are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { prettySize, type MediaItem } from "../../lib/chatEnvelope";
import type { DocumentMode } from "../../lib/attachmentCapability";
import { AttachmentViewer } from "../AttachmentViewer";
import { DocumentViewer } from "./DocumentViewer";
import { PREVIEW_POLL_BUDGET_MS, readPrefix } from "./useDocumentPreview";

const SIGNED = "https://msg.test/media/att-1?t=tok";
const PREVIEW = "https://msg.test/media/att-1/preview?t=tok";

const item = (name: string, mime = "application/zip"): MediaItem => ({ id: "att-1", name, size: 4096, mime });
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const sheet = (name: string, csv: string, over: Record<string, unknown> = {}) => ({
  name,
  csv,
  totalRows: csv.split("\n").filter(Boolean).length,
  truncated: false,
  ...over,
});
const artifact = (...sheets: ReturnType<typeof sheet>[]) => ({ sheets, moreSheets: false });
const status = (code: number, headers: Record<string, string> = {}) => new Response("", { status: code, headers });

let fetchStub: ReturnType<typeof vi.fn>;
let created: Blob[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
    created.push(b as Blob);
    return `blob:viewer-${created.length}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
  fetchStub = vi.fn();
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderViewer(
  it_: MediaItem,
  mode: DocumentMode,
  opts: { url?: string | undefined; onDownload?: (i: MediaItem) => void; onClose?: () => void } = {},
) {
  const onClose = opts.onClose ?? vi.fn();
  render(
    <DocumentViewer
      item={it_}
      url={"url" in opts ? opts.url : SIGNED}
      mode={mode}
      onClose={onClose}
      onDownload={opts.onDownload}
    />,
  );
  return { onClose };
}

describe("Word / PowerPoint → the converted PDF", () => {
  it("asks the server for the preview on the same signed link and shows it in a frame", async () => {
    fetchStub.mockResolvedValue(new Response("%PDF-1.7 converted", { status: 200, headers: { "content-type": "application/pdf" } }));
    renderViewer(item("Brief.docx"), "pdf");

    const frame = await screen.findByTitle("Brief.docx");

    expect(fetchStub).toHaveBeenCalledWith(PREVIEW, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("src", "blob:viewer-1");
    // Re-typed: the browser's PDF viewer needs application/pdf whatever the transport said.
    expect(created[0]!.type).toBe("application/pdf");
    // Not sandboxed: a sandboxed frame stops the browser's PDF viewer loading.
    expect(frame).not.toHaveAttribute("sandbox");
  });

  it("while the server is still converting (202) it says so and asks again, then shows the PDF", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchStub
      .mockResolvedValueOnce(status(202, { "Retry-After": "2" }))
      .mockResolvedValueOnce(status(202, { "Retry-After": "2" }))
      .mockResolvedValueOnce(new Response("%PDF-1.7", { status: 200 }));
    renderViewer(item("Deck.pptx"), "pdf");

    expect(await screen.findByText(/Preparing a preview/)).toBeInTheDocument();
    expect(fetchStub).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(screen.queryByTitle("Deck.pptx")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await screen.findByTitle("Deck.pptx")).toBeInTheDocument();
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(fetchStub.mock.calls.every((c) => c[0] === PREVIEW)).toBe(true);
  });

  it("clamps an absurd Retry-After, and defaults a missing one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchStub
      .mockResolvedValueOnce(status(202, { "Retry-After": "3600" }))
      .mockResolvedValueOnce(status(202))
      .mockResolvedValueOnce(new Response("%PDF-1.7", { status: 200 }));
    renderViewer(item("a.docx"), "pdf");
    await screen.findByText(/Preparing a preview/);

    await act(() => vi.advanceTimersByTimeAsync(10_100)); // clamped to 10s, not an hour
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(3100)); // default 3s
    expect(await screen.findByTitle("a.docx")).toBeInTheDocument();
  });

  it("gives up after the polling budget and falls back to Download", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchStub.mockImplementation(async () => status(202, { "Retry-After": "10" }));
    const onDownload = vi.fn();
    renderViewer(item("slow.docx"), "pdf", { onDownload });

    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_POLL_BUDGET_MS + 11_000));

    expect(await screen.findByText("This is taking longer than expected.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("stops asking, and releases the PDF, when it is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchStub.mockResolvedValue(status(202, { "Retry-After": "1" }));
    const { unmount } = render(
      <DocumentViewer item={item("a.docx")} url={SIGNED} mode="pdf" onClose={() => {}} />,
    );
    await screen.findByText(/Preparing a preview/);
    const signal = (fetchStub.mock.calls[0]![1] as { signal: AbortSignal }).signal;

    unmount();
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(signal.aborted).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("revokes the PDF's object URL when closed", async () => {
    fetchStub.mockResolvedValue(new Response("%PDF-1.7", { status: 200 }));
    const { unmount } = render(<DocumentViewer item={item("a.docx")} url={SIGNED} mode="pdf" onClose={() => {}} />);
    await screen.findByTitle("a.docx");

    unmount();

    expect(revoked).toEqual(["blob:viewer-1"]);
  });

  it("stays at 'loading' and fetches nothing while the signed link is still being minted", () => {
    renderViewer(item("a.docx"), "pdf", { url: undefined });

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("Excel → a read-only data grid", () => {
  it("shows the sheets as tabs, the always-visible limitation notice, and the cell text", async () => {
    fetchStub.mockResolvedValue(
      json(artifact(sheet("Budget", "Item,Cost\nRent,1200\nFood,300\n"), sheet("Zwei ünï", "x,y\n1,2\n"))),
    );
    renderViewer(item("Budget.xlsx"), "sheet");

    expect(await screen.findByRole("tab", { name: "Budget" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/Simple data view\. Formatting, merged cells, charts and images aren't shown/)).toBeInTheDocument();
    expect(screen.getByText("Rent")).toBeInTheDocument();
    expect(screen.getByText("1200")).toBeInTheDocument();
    // Spreadsheet furniture: column letters and row numbers.
    expect(screen.getByRole("columnheader", { name: "B" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "3" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Zwei ünï" }));
    expect(screen.getByRole("tab", { name: "Zwei ünï" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Rent")).not.toBeInTheDocument();
    expect(screen.getByText("y")).toBeInTheDocument();
  });

  it("a single sheet has no tab strip", async () => {
    fetchStub.mockResolvedValue(json(artifact(sheet("Only", "a,b\n"))));
    renderViewer(item("a.xls", "application/octet-stream"), "sheet");

    await screen.findByText("a");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("renders cell text as TEXT — markup in a cell is never interpreted", async () => {
    fetchStub.mockResolvedValue(json(artifact(sheet("S", '"<img src=x onerror=alert(1)>","<b>bold</b>"\n'))));
    const { container } = render(
      <DocumentViewer item={item("a.xlsx")} url={SIGNED} mode="sheet" onClose={() => {}} />,
    );

    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("says when rows were cut: the first N of the total", async () => {
    fetchStub.mockResolvedValue(json(artifact(sheet("Big", "a\nb\nc\n", { totalRows: 90000, truncated: true }))));
    renderViewer(item("big.xlsx"), "sheet");

    expect(await screen.findByText("Showing the first 3 rows of 90000.")).toBeInTheDocument();
  });

  it("draws a long sheet in steps, so the page stays light", async () => {
    const csv = Array.from({ length: 700 }, (_, i) => `row${i}`).join("\n") + "\n";
    fetchStub.mockResolvedValue(json(artifact(sheet("Long", csv))));
    renderViewer(item("long.xlsx"), "sheet");

    await screen.findByText("row0");
    expect(screen.getByText("row199")).toBeInTheDocument();
    expect(screen.queryByText("row200")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show more rows" }));
    expect(screen.getByText("row599")).toBeInTheDocument();
    expect(screen.queryByText("row600")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show more rows" }));
    expect(screen.getByText("row699")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more rows" })).not.toBeInTheDocument();
  });

  it("says so when the workbook has more sheets than the preview carries", async () => {
    fetchStub.mockResolvedValue(json({ sheets: [sheet("A", "1\n"), sheet("B", "2\n")], moreSheets: true }));
    renderViewer(item("many.xlsx"), "sheet");

    expect(await screen.findByText("Only the first 2 sheets are shown.")).toBeInTheDocument();
  });

  it("shows an empty sheet as empty", async () => {
    fetchStub.mockResolvedValue(json(artifact(sheet("Blank", ""))));
    renderViewer(item("blank.xlsx"), "sheet");

    expect(await screen.findByText("This sheet is empty.")).toBeInTheDocument();
  });
});

describe("CSV and text, read in the browser", () => {
  it("shows a CSV as a grid (with its own, shorter notice) read from the signed URL itself", async () => {
    fetchStub.mockResolvedValue(new Response("name;qty\nbolt;4\n", { status: 200 }));
    renderViewer(item("parts.csv", "text/plain"), "csv");

    expect(await screen.findByText("bolt")).toBeInTheDocument();
    expect(fetchStub).toHaveBeenCalledWith(SIGNED, expect.anything()); // not /preview: no sandbox needed
    expect(screen.getByText(/Download the file to open it in a spreadsheet app/)).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "B" })).toBeInTheDocument(); // the ';' was detected
  });

  it("decodes a UTF-16 .txt whose envelope claims it is not text/plain", async () => {
    const text = "héllo\nwörld";
    const bytes = new Uint8Array([0xff, 0xfe, ...[...text].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])]);
    fetchStub.mockResolvedValue(new Response(bytes, { status: 200 }));
    const { container } = render(
      <DocumentViewer item={item("notes.txt", "application/octet-stream")} url={SIGNED} mode="text" onClose={() => {}} />,
    );

    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe("héllo\nwörld"));
  });

  it("shows only the first part of a big file, whole lines only, and says so", async () => {
    const line = "x".repeat(99) + "\n";
    const big = line.repeat(Math.ceil((4 * 1024 * 1024) / line.length) + 500);
    fetchStub.mockResolvedValue(new Response(big, { status: 200 }));
    const { container } = render(
      <DocumentViewer item={item("huge.txt", "application/octet-stream")} url={SIGNED} mode="text" onClose={() => {}} />,
    );

    expect(await screen.findByText("Showing only the first part of this file.")).toBeInTheDocument();
    const shown = container.querySelector("pre")!.textContent!;
    expect(shown.length).toBeLessThan(big.length);
    expect(shown.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(shown.endsWith("x")).toBe(true); // cut at a line end, not mid-line
    expect(shown.split("\n").every((l) => l.length === 99)).toBe(true);
  });

  it("says a CSV is cut when it exceeds the read ceiling", async () => {
    const line = "a,b,c\n";
    fetchStub.mockResolvedValue(new Response(line.repeat(Math.ceil((4 * 1024 * 1024) / line.length) + 100), { status: 200 }));
    renderViewer(item("huge.csv", "text/plain"), "csv");

    expect(await screen.findByText(/Showing the first \d+ rows\./)).toBeInTheDocument();
  });

  it("shows an empty file as empty", async () => {
    fetchStub.mockResolvedValue(new Response("", { status: 200 }));
    renderViewer(item("empty.txt", "application/octet-stream"), "text");

    expect(await screen.findByText("This file is empty.")).toBeInTheDocument();
  });

  it("does not interpret markup in a text file", async () => {
    fetchStub.mockResolvedValue(new Response("<script>alert(1)</script><img src=x>", { status: 200 }));
    renderViewer(item("evil.txt", "application/octet-stream"), "text");

    expect(await screen.findByText("<script>alert(1)</script><img src=x>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("when a document cannot be previewed, Download is the fallback", () => {
  it.each([
    ["the server refused the type", 415, "This document can't be previewed."],
    ["the document could not be converted", 422, "This document can't be previewed."],
    ["the link expired or access was revoked", 403, "This document can't be previewed."],
    ["it is gone", 404, "This document can't be previewed."],
    ["it is over the size ceiling", 413, "This file is too large to preview."],
    ["the sandbox is off or unreachable", 503, "Previews are temporarily unavailable."],
    ["the gateway timed out", 504, "Previews are temporarily unavailable."],
    ["too many previews were started", 429, "Too many previews at once. Try again in a moment."],
    ["the server fell over", 500, "This document can't be previewed."],
  ])("%s (%i)", async (_why, code, message) => {
    fetchStub.mockResolvedValue(status(code));
    const onDownload = vi.fn();
    renderViewer(item("Brief.docx"), "pdf", { onDownload });

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "att-1", name: "Brief.docx" }));
  });

  it("a network failure says so", async () => {
    fetchStub.mockRejectedValue(new TypeError("Failed to fetch"));
    renderViewer(item("a.docx"), "pdf", { onDownload: vi.fn() });

    expect(await screen.findByText("Couldn't load the preview. Check your connection.")).toBeInTheDocument();
  });

  it.each([
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["JSON of the wrong shape", () => json({ hello: "world" })],
    ["a sheets artifact with no sheets", () => json({ sheets: [] })],
    ["an artifact with a malformed sheet", () => json({ sheets: [{ name: "x" }] })],
  ])("a spreadsheet reply that is %s is refused, never rendered", async (_l, reply) => {
    fetchStub.mockResolvedValue(reply());
    renderViewer(item("a.xlsx"), "sheet", { onDownload: vi.fn() });

    expect(await screen.findByText("This document can't be previewed.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("a CSV that cannot be read falls back too", async () => {
    fetchStub.mockResolvedValue(status(403));
    renderViewer(item("a.csv", "text/plain"), "csv", { onDownload: vi.fn() });

    expect(await screen.findByText("This document can't be previewed.")).toBeInTheDocument();
  });

  it("offers no Download button when the surface provided none", async () => {
    fetchStub.mockResolvedValue(status(422));
    renderViewer(item("a.docx"), "pdf");

    expect(await screen.findByText("This document can't be previewed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  });
});

describe("the overlay", () => {
  it("is a modal dialog named for the file, with its size", async () => {
    fetchStub.mockResolvedValue(status(422));
    renderViewer(item("Brief.docx"), "pdf");

    const dialog = await screen.findByRole("dialog", { name: "Brief.docx" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(prettySize(4096))).toBeInTheDocument();
  });

  it("closes on Escape, on the close button and on a backdrop click — not on a click inside", async () => {
    fetchStub.mockResolvedValue(json(artifact(sheet("S", "a,b\n"))));
    const { onClose } = renderViewer(item("a.xlsx"), "sheet");
    await screen.findByText("a");

    await userEvent.click(screen.getByText("a")); // inside the grid
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("has no download button of its own — one audited path per surface", async () => {
    fetchStub.mockResolvedValue(json(artifact(sheet("S", "a\n"))));
    renderViewer(item("a.xlsx"), "sheet", { onDownload: vi.fn() });
    await screen.findByText("a");

    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });
});

describe("AttachmentViewer routes between the new viewer and the untouched Lightbox", () => {
  const urlFor = (id: string | undefined) => (id ? `https://msg.test/media/${id}?t=tok` : undefined);
  const show = (items: MediaItem[], index = 0) =>
    render(<AttachmentViewer items={items} index={index} urlFor={urlFor} onClose={() => {}} onIndexChange={() => {}} />);

  it("a Word file goes to the document viewer", async () => {
    fetchStub.mockResolvedValue(new Response("%PDF-1.7", { status: 200 }));
    show([item("Brief.docx")]);

    expect(await screen.findByTitle("Brief.docx")).toBeInTheDocument();
    expect(fetchStub).toHaveBeenCalledWith(PREVIEW, expect.anything());
  });

  it("an image goes to the Lightbox, which draws it itself and fetches nothing", () => {
    show([{ id: "i1", name: "photo.png", size: 10, mime: "image/png" }]);

    expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute("src", "https://msg.test/media/i1?t=tok");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("a PDF goes to the Lightbox's own frame path, not the preview route", async () => {
    fetchStub.mockResolvedValue(new Response("%PDF-1.4", { status: 200 }));
    show([{ id: "p1", name: "Report.pdf", size: 10, mime: "application/pdf" }]);

    expect(await screen.findByTitle("Report.pdf")).toBeInTheDocument();
    // The Lightbox reads the signed URL itself (however it chooses to call fetch);
    // the preview route is for documents the browser cannot show, never for a PDF.
    expect(fetchStub.mock.calls[0]![0]).toBe("https://msg.test/media/p1?t=tok");
    expect(fetchStub.mock.calls.some((c) => String(c[0]).includes("/preview"))).toBe(false);
  });

  it("a gallery keeps its arrows; the Lightbox is passed exactly what it always was", () => {
    show([
      { id: "i1", name: "a.png", size: 10, mime: "image/png" },
      { id: "i2", name: "b.png", size: 10, mime: "image/png" },
    ]);

    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });
});

describe("readPrefix", () => {
  const streamOf = (chunks: Uint8Array[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          chunks.forEach((x) => c.enqueue(x));
          c.close();
        },
      }),
    );

  it("returns everything when the body is within the ceiling", async () => {
    const r = await readPrefix(streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), 10);
    expect(r).toEqual({ bytes: new Uint8Array([1, 2, 3, 4, 5]), truncated: false });
  });

  it("returns exactly the ceiling and says truncated when the body is longer, and cancels the download", async () => {
    let cancelled = false;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new Uint8Array(4).fill(7));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const r = await readPrefix(res, 10);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toHaveLength(10);
    expect(cancelled).toBe(true);
  });

  it("a body of exactly the ceiling is not truncated", async () => {
    const r = await readPrefix(streamOf([new Uint8Array(10)]), 10);
    expect(r.truncated).toBe(false);
    expect(r.bytes).toHaveLength(10);
  });
});
