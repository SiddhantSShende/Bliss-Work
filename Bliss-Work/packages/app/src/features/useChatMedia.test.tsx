import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
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
const reverseGeocode = vi.fn();
const whereami = vi.fn();
const hasPreciseLocation = vi.fn();
const openLocationSettings = vi.fn();

/** Whether the host offers an OS location-settings page. Undefined models
 *  Linux and the web, where there is nothing to open. */
let settingsCapability: (() => Promise<boolean>) | undefined;

/** Which host the hook believes it is running in. Mutated per test — it is the
 *  whole difference between "the user declined a prompt" and "the platform
 *  refused something the user was never shown". */
let hostKind: "web" | "electron" = "web";

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({
    api: {
      uploadAttachment,
      commitAttachment,
      attachmentLinks,
      mediaUrl: (p: string) => `https://example.test${p}`,
      staticMap: vi.fn().mockResolvedValue(null),
      reverseGeocode,
      whereami,
    },
    get config() {
      return { kind: hostKind, hasPreciseLocation, openLocationSettings: settingsCapability };
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
        // Every real surface routes Send through flushStaged, not through its
        // own send mutation — that is what makes attachments wait for the user.
        onSend={media.flushStaged}
        onAttach={media.onAttach}
        onShareLocation={media.onShareLocation}
        onPaste={media.onPaste}
        dragging={media.dragging}
        attachments={media.staged}
        onRemoveAttachment={media.removeStaged}
        uploading={Object.keys(media.uploads).length}
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
  hostKind = "web";
  settingsCapability = undefined;
  openLocationSettings.mockResolvedValue(true);
  reverseGeocode.mockResolvedValue(null);
  whereami.mockResolvedValue({ lat: 12.97, lng: 77.59 });
  hasPreciseLocation.mockResolvedValue(false);
});

/** Drive getCurrentPosition to its error callback with `code`. */
function geolocationFailsWith(code: number) {
  const getCurrentPosition = vi.fn(
    (_ok: PositionCallback, fail?: PositionErrorCallback | null) =>
      fail?.({
        code,
        message: "",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError),
  );
  Object.defineProperty(globalThis.navigator, "geolocation", {
    value: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() },
    configurable: true,
  });
  return getCurrentPosition;
}

const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;

/**
 * Sharing a location when the position provider says no.
 *
 * The desktop app grants "geolocation" in its own permission handler and so
 * never shows a prompt — which means a PERMISSION_DENIED there was NEVER the
 * user declining, and treating it as one made the feature fail outright on
 * every Windows box with the location toggle off and on every Linux desktop.
 */
describe("sharing a location when the device refuses", () => {
  it("falls back to a coarse fix on desktop, where the user is never asked", async () => {
    hostKind = "electron";
    geolocationFailsWith(PERMISSION_DENIED);
    const { send } = renderHarness();

    await userEvent.click(screen.getByLabelText("Share your location"));

    // The location still goes out — that is the whole bug.
    await waitFor(() => expect(whereami).toHaveBeenCalled());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toContain("12.97");
  });

  it("honours a real refusal in the browser, which does prompt", async () => {
    hostKind = "web";
    geolocationFailsWith(PERMISSION_DENIED);
    const { send } = renderHarness();

    await userEvent.click(screen.getByLabelText("Share your location"));

    // Overriding someone who clicked "Block" with an IP lookup would be a
    // betrayal, so nothing is sent and nothing is looked up.
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(whereami).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("still falls back for a plain device failure in the browser", async () => {
    hostKind = "web";
    geolocationFailsWith(POSITION_UNAVAILABLE);
    const { send } = renderHarness();

    await userEvent.click(screen.getByLabelText("Share your location"));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});

/** The last `toast(...)` call's options, for asserting on the action button. */
function lastToastOptions() {
  const calls = (toast as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[calls.length - 1]?.[1] as
    | { description?: string; action?: { label: string; onClick: () => void } }
    | undefined;
}

/**
 * Offering the OS location settings page.
 *
 * Windows cannot prompt a desktop app for location at all, so a deep link to
 * the settings page is the closest the platform allows to asking. The gating is
 * the interesting part: it must appear only when the OS is what refused, and
 * only where such a page exists.
 */
describe("the open-location-settings button", () => {
  it("is offered when the OS refused and the platform has a settings page", async () => {
    hostKind = "electron";
    settingsCapability = openLocationSettings;
    geolocationFailsWith(PERMISSION_DENIED);
    renderHarness();

    await userEvent.click(screen.getByLabelText("Share your location"));
    await waitFor(() => expect(toast).toHaveBeenCalled());

    const opts = lastToastOptions();
    expect(opts?.action?.label).toBe("Open settings");
    expect(opts?.description).toContain("Location access is off");

    opts!.action!.onClick();
    expect(openLocationSettings).toHaveBeenCalled();
  });

  it("is withheld on a platform with no settings page, even when the OS refused", async () => {
    // Linux: the host omits the capability because there is no OS location
    // provider to authorize. A button here would open nothing.
    hostKind = "electron";
    settingsCapability = undefined;
    geolocationFailsWith(PERMISSION_DENIED);
    renderHarness();

    await userEvent.click(screen.getByLabelText("Share your location"));
    await waitFor(() => expect(toast).toHaveBeenCalled());

    expect(lastToastOptions()?.action).toBeUndefined();
  });

  it("is withheld when the device merely failed to get a fix", async () => {
    // The OS never refused, so sending someone to the location toggle would be
    // pointing them at something that was not the cause.
    hostKind = "electron";
    settingsCapability = openLocationSettings;
    geolocationFailsWith(POSITION_UNAVAILABLE);
    renderHarness();

    await userEvent.click(screen.getByLabelText("Share your location"));
    await waitFor(() => expect(toast).toHaveBeenCalled());

    expect(lastToastOptions()?.action).toBeUndefined();
    expect(openLocationSettings).not.toHaveBeenCalled();
  });
});

/** A file-only drop's dataTransfer — no text/plain representation, matching a
 *  real OS file drag (Finder/Explorer). */
function fileDataTransfer(files: File[]) {
  return { files, types: ["Files"], getData: () => "" };
}

/**
 * A LINK drag that ALSO advertises a "Files" type — the exact drag/paste
 * shape behind the desktop link-as-attachment bug: some sources (a browser's
 * address bar, an Internet Shortcut) put a synthetic file on the
 * clipboard/drag alongside the plain-text URL, particularly on Electron's
 * bundled Chromium. `files` defaults to a stand-in for that synthetic file.
 */
function urlDataTransfer(url: string, files: File[] = [new File([""], "link.url")]) {
  return { files, types: ["Files"], getData: () => url };
}

/** Same shape as urlDataTransfer, but for clipboardData (paste rather than
 *  drop) — a DataTransferItemList of one file-kind item plus the URL text. */
function urlClipboardData(url: string, file: File = new File([""], "link.url")) {
  return {
    items: [{ kind: "file", getAsFile: () => file }],
    getData: () => url,
  };
}

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

  it("uploads the chosen file but sends nothing until Send is pressed", async () => {
    const { send } = renderHarness();
    const input = screen.getByTestId("file-input") as HTMLInputElement;

    await userEvent.upload(input, new File(["abc"], "notes.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    const [scope, scopeId, file, opts] = uploadAttachment.mock.calls[0]!;
    expect(scope).toBe("thread");
    expect(scopeId).toBe("018f0000-0000-7000-8000-000000000001");
    expect((file as File).name).toBe("notes.pdf");
    expect((opts as { filename: string }).filename).toBe("notes.pdf");

    // The file is STAGED: a chip appears, and nothing has been sent or
    // committed. Picking a file used to fire the message immediately.
    await waitFor(() => expect(screen.getByText("notes.pdf")).toBeInTheDocument());
    expect(send).not.toHaveBeenCalled();
    expect(commitAttachment).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTitle("Send"));

    // Exactly one message for the batch, carrying the envelope.
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toContain("notes.pdf");

    // Committed only after the send, so an abandoned upload lapses on its own.
    await waitFor(() => expect(commitAttachment).toHaveBeenCalledWith("018f0000-0000-7000-8000-0000000000aa"));
  });

  // THE reported bug: dragging an image into the chat delivered it before the
  // sender could look at it. A drop now ASKS first, and confirming only
  // ATTACHES — the message still waits for Send.
  it("asks before attaching a dropped file, then stages it", async () => {
    const { send } = renderHarness();
    const dropzone = screen.getByLabelText("Attach a file").closest("div")!.parentElement!;
    const file = new File(["abc"], "photo.png", { type: "image/png" });

    fireEvent.drop(dropzone, { dataTransfer: fileDataTransfer([file]) });

    // Nothing is uploaded on the drop itself: an accidental drop must cost
    // nothing, not even an orphaned upload waiting to lapse.
    await screen.findByText("Attach this file?");
    expect(uploadAttachment).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Attach" }));

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    expect((uploadAttachment.mock.calls[0]![2] as File).name).toBe("photo.png");
    // The chip is named from the SERVER's response, which this suite's mock
    // always answers as notes.pdf regardless of what went up.
    await waitFor(() => expect(screen.getByText("notes.pdf")).toBeInTheDocument());
    expect(send).not.toHaveBeenCalled();
  });

  it("uploads nothing when a dropped file is declined", async () => {
    const { send } = renderHarness();
    const dropzone = screen.getByLabelText("Attach a file").closest("div")!.parentElement!;
    const file = new File(["abc"], "photo.png", { type: "image/png" });

    fireEvent.drop(dropzone, { dataTransfer: fileDataTransfer([file]) });
    await screen.findByText("Attach this file?");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText("Attach this file?")).not.toBeInTheDocument(),
    );
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("drops a staged file from the tray without sending it", async () => {
    const { send } = renderHarness();
    const input = screen.getByTestId("file-input") as HTMLInputElement;

    await userEvent.upload(input, new File(["abc"], "notes.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(screen.getByText("notes.pdf")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("Remove notes.pdf"));

    expect(screen.queryByText("notes.pdf")).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    // Never committed, so the orphaned upload lapses server-side on its own.
    expect(commitAttachment).not.toHaveBeenCalled();
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

/**
 * THE reported bug: on desktop, sending a bare link (e.g. https://example.com)
 * was detected/sent as a file attachment instead of a plain link message.
 * Root cause — the OS clipboard/drag payload for copying or dragging a LINK
 * can carry a synthetic file (e.g. an Internet Shortcut) alongside the very
 * same URL text, particularly on Electron's bundled Chromium; onPaste/onDrop
 * used to treat the presence of any file-kind item as proof of a real file.
 * These pin the fix: a paste/drop is only ever treated as a file when its
 * text is not JUST a bare URL — real file pastes/drops (no such text) must
 * keep working exactly as before.
 */
describe("sending a link, not a file", () => {
  it("pasting a bare URL sends it as a normal message, not an attachment", async () => {
    hostKind = "electron";
    const { send } = renderHarness();
    const textarea = screen.getByPlaceholderText("Write a message…");

    fireEvent.paste(textarea, { clipboardData: urlClipboardData("https://example.com") });

    // Never treated as a file: no upload, no staged chip, nothing to send yet.
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText("link.url")).not.toBeInTheDocument();

    // The native paste was left alone, so the URL landed in the textarea as
    // ordinary text — the same as typing it — and Send fires the plain text
    // message, exactly like the web app.
    fireEvent.change(textarea, { target: { value: "https://example.com" } });
    await userEvent.click(screen.getByTitle("Send"));

    expect(send).toHaveBeenCalledWith("https://example.com");
    expect(commitAttachment).not.toHaveBeenCalled();
  });

  it("pasting a file with no URL text still uploads as an attachment", async () => {
    hostKind = "electron";
    renderHarness();
    const textarea = screen.getByPlaceholderText("Write a message…");
    const file = new File(["abc"], "photo.png", { type: "image/png" });

    fireEvent.paste(textarea, {
      clipboardData: { items: [{ kind: "file", getAsFile: () => file }], getData: () => "" },
    });

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    expect((uploadAttachment.mock.calls[0]![2] as File).name).toBe("photo.png");
  });

  it("dropping a bare URL sends it as a normal message, not an attachment", async () => {
    hostKind = "electron";
    renderHarness();
    const dropzone = screen.getByLabelText("Attach a file").closest("div")!.parentElement!;

    fireEvent.drop(dropzone, { dataTransfer: urlDataTransfer("https://example.com") });

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText("Attach this file?")).not.toBeInTheDocument();
  });

  it("dropping a real file with no URL text still asks to attach it", async () => {
    hostKind = "electron";
    renderHarness();
    const dropzone = screen.getByLabelText("Attach a file").closest("div")!.parentElement!;
    const file = new File(["abc"], "photo.png", { type: "image/png" });

    fireEvent.drop(dropzone, { dataTransfer: fileDataTransfer([file]) });

    await screen.findByText("Attach this file?");
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("behaves identically on web — the fix is platform-agnostic", async () => {
    hostKind = "web";
    const { send } = renderHarness();
    const dropzone = screen.getByLabelText("Attach a file").closest("div")!.parentElement!;

    fireEvent.drop(dropzone, { dataTransfer: urlDataTransfer("https://example.com") });

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
