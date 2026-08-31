/**
 * The meeting room's code chunk previously had no load timeout: a hard
 * refresh forces `import("./CallRoom")` onto a cold network path (see
 * apps/web/src/main.tsx's SW/Cache Storage wipe on every load), and a
 * request that stalled — rather than outright failing — left the room on
 * "Connecting…" forever, with nothing in the app able to recover it. These
 * tests pin the two outcomes that now exist instead of that hang: it works,
 * or it fails visibly with something to click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CallDTO } from "@taskboard/shared";

const CALL = { id: "call-1", title: "Standup" } as CallDTO;

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {}); // ErrorBoundary logs on catch
});

afterEach(() => {
  vi.doUnmock("./CallRoom");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CallRoomLazy", () => {
  it("renders the real room once its chunk resolves", async () => {
    vi.doMock("./CallRoom", () => ({
      CallRoom: ({ call }: { call: CallDTO }) => <div>Room for {call.title}</div>,
    }));
    const { CallRoom } = await import("./CallRoomLazy");

    render(<CallRoom call={CALL} onClose={() => {}} />);

    expect(await screen.findByText("Room for Standup")).toBeTruthy();
  });

  it("shows an actionable error instead of hanging forever when the chunk load stalls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Never settles — simulates a stalled (not failed) network request.
    vi.doMock("./CallRoom", () => new Promise<never>(() => {}));
    const { CallRoom } = await import("./CallRoomLazy");

    render(<CallRoom call={CALL} onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(15_000);

    const message = await screen.findByText("Something went wrong opening the meeting room.");
    expect(message).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    // MeetingHost renders <CallRoom> as a plain sibling after whatever the
    // router rendered — nothing else gives this an overlay context, so
    // without fixed/inset-0 the Reload button rendered a full viewport
    // below the current route's content: present in the DOM, invisible to
    // the user, indistinguishable from the chunk never loading at all.
    const overlay = message.parentElement;
    expect(overlay?.className).toContain("fixed");
    expect(overlay?.className).toContain("inset-0");
    expect(overlay?.className).toContain("z-[100]");
  });

  it("keeps the loading placeholder on-screen (fixed overlay) rather than in normal document flow", async () => {
    let resolveImport!: (v: { CallRoom: () => null }) => void;
    vi.doMock(
      "./CallRoom",
      () => new Promise((resolve) => { resolveImport = resolve; }),
    );
    const { CallRoom } = await import("./CallRoomLazy");

    render(<CallRoom call={CALL} onClose={() => {}} />);
    const placeholder = await screen.findByText("Connecting…");
    const overlay = placeholder.closest("div");
    expect(overlay?.className).toContain("fixed");
    expect(overlay?.className).toContain("inset-0");
    expect(overlay?.className).toContain("z-[100]");

    resolveImport({ CallRoom: () => null });
  });

  it("shows the same actionable error when the chunk import rejects outright", async () => {
    vi.doMock("./CallRoom", () => Promise.reject(new Error("network error")));
    const { CallRoom } = await import("./CallRoomLazy");

    render(<CallRoom call={CALL} onClose={() => {}} />);

    expect(
      await screen.findByText("Something went wrong opening the meeting room."),
    ).toBeTruthy();
  });

  it("reload reloads the page rather than retrying in place (React.lazy cannot retry a settled import)", async () => {
    vi.doMock("./CallRoom", () => Promise.reject(new Error("network error")));
    const { CallRoom } = await import("./CallRoomLazy");
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });

    render(<CallRoom call={CALL} onClose={() => {}} />);
    (await screen.findByRole("button", { name: "Reload" })).click();

    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
