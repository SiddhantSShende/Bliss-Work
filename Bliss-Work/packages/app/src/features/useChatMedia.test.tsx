import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useChatMedia } from "./useChatMedia";
import { Composer } from "./Composer";

/**
 * Reproduces what a user actually does: click the paperclip, choose a file,
 * expect it to upload.
 *
 * This exists because two rounds of fixing "files won't share" were made
 * against static reading of the code while production metrics showed the upload
 * request was never issued at all. Nothing covered the click -> picker ->
 * onChange -> upload chain, so a break anywhere in it was invisible.
 */

const uploadAttachment = vi.fn();
const commitAttachment = vi.fn();
const attachmentLinks = vi.fn();

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({
    api: {
      uploadAttachment,
      commitAttachment,
      attachmentLinks,
      mediaUrl: (p: string) => `https://example.test${p}`,
      staticMap: vi.fn().mockResolvedValue(null),
    },
  }),
}));

vi.mock("../lib/fileTransfer", () => ({
  useFileTransfers: () => ({
    available: false,
    stateOf: () => undefined,
    accept: vi.fn(),
    decline: vi.fn(),
    cancel: vi.fn(),
    send: vi.fn(),
  }),
}));

// Poster generation is exercised by thumbnail.test.ts; here it must simply not
// interfere with the upload.
vi.mock("../lib/thumbnail", () => ({
  makeThumbnail: vi.fn().mockResolvedValue({ thumb: null, dimensions: {} }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

/** Mirrors how every real surface wires the hook: Composer + the hidden input. */
function Harness({ send = vi.fn() }: { send?: (b: string) => void }) {
  const media = useChatMedia({
    scope: "thread",
    scopeId: "018f0000-0000-7000-8000-000000000001",
    meId: "me",
    send,
  });
  return (
    <div {...media.dropzone}>
      <Composer
        onSend={send}
        onAttach={media.onAttach}
        onShareLocation={media.onShareLocation}
        onPaste={media.onPaste}
        dragging={media.dragging}
      />
      <input data-testid="file-input" {...media.fileInputProps} />
      {media.overlay}
    </div>
  );
}

function renderHarness(send = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness send={send} />
    </QueryClientProvider>,
  );
  return { send };
}

beforeEach(() => {
  vi.clearAllMocks();
  uploadAttachment.mockResolvedValue({
    id: "018f0000-0000-7000-8000-0000000000aa",
    scope: "thread",
    scopeId: "018f0000-0000-7000-8000-000000000001",
    role: "file",
    sha256: "a".repeat(64),
    mime: "application/pdf",
    sizeBytes: 3,
    filename: "notes.pdf",
    createdAt: new Date(0).toISOString(),
  });
  commitAttachment.mockResolvedValue(undefined);
  attachmentLinks.mockResolvedValue([]);
});

describe("attaching a file", () => {
  it("opens the file picker when the paperclip is clicked", async () => {
    renderHarness();
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    // The ref must actually reach the DOM node — if it doesn't, onAttach calls
    // click() on undefined, the picker never opens, and nothing at all happens.
    const clickSpy = vi.spyOn(input, "click");

    await userEvent.click(screen.getByLabelText("Attach a file"));

    expect(clickSpy).toHaveBeenCalled();
  });

  it("uploads the chosen file and sends one message referencing it", async () => {
    const { send } = renderHarness();
    const input = screen.getByTestId("file-input") as HTMLInputElement;

    await userEvent.upload(input, new File(["abc"], "notes.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    const [scope, scopeId, file, opts] = uploadAttachment.mock.calls[0]!;
    expect(scope).toBe("thread");
    expect(scopeId).toBe("018f0000-0000-7000-8000-000000000001");
    expect((file as File).name).toBe("notes.pdf");
    expect((opts as { filename: string }).filename).toBe("notes.pdf");

    // Exactly one message for the batch, carrying the envelope.
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toContain("notes.pdf");

    // Committed only after the send, so an abandoned upload lapses on its own.
    await waitFor(() => expect(commitAttachment).toHaveBeenCalledWith("018f0000-0000-7000-8000-0000000000aa"));
  });

  it("accepts a file type no allowlist would have included", async () => {
    // The picker must not restrict what can be chosen; the server decides what
    // is safe to serve back.
    renderHarness();
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    expect(input.getAttribute("accept")).toBeNull();

    await userEvent.upload(input, new File(["x"], "archive.rar", { type: "" }));
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
  });

  // THE regression. A real browser's `input.files` is a LIVE FileList that
  // `input.value = ""` empties IN PLACE. Reading it after the reset saw zero
  // files and silently dropped the selection — no upload, no error, nothing.
  // jsdom replaces the list instead of mutating it, which is why the ordinary
  // upload test above passed while production was broken.
  it("still uploads when the browser empties FileList on reset", async () => {
    renderHarness();
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    const file = new File(["abc"], "notes.pdf", { type: "application/pdf" });

    // Model Chromium: one FileList instance, emptied in place by `value = ""`.
    const live: { length: number; 0?: File; [Symbol.iterator]: () => Iterator<File> } = {
      length: 1,
      0: file,
      [Symbol.iterator]: function* () {
        for (let i = 0; i < this.length; i++) yield (this as Record<number, File>)[i]!;
      },
    };
    Object.defineProperty(input, "files", { get: () => live, configurable: true });
    Object.defineProperty(input, "value", {
      get: () => "",
      set: () => {
        live.length = 0;
        delete live[0];
      },
      configurable: true,
    });

    await userEvent.click(screen.getByLabelText("Attach a file"));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    expect((uploadAttachment.mock.calls[0]![2] as File).name).toBe("notes.pdf");
  });

  it("allows selecting several files at once", async () => {
    renderHarness();
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    expect(input.multiple).toBe(true);

    await userEvent.upload(input, [
      new File(["a"], "a.pdf", { type: "application/pdf" }),
      new File(["b"], "b.pdf", { type: "application/pdf" }),
    ]);
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(2));
  });
});
