import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWhatsAppForward } from "./useWhatsAppForward";

/**
 * The point of this hook is WHEN it writes, not that it can write.
 *
 * Forwarding used to record on the click, which meant a blocked popup, a
 * missing WhatsApp install and a user who bounced off the login wall all left
 * the same audit pill in the thread as a real forward. These tests pin the
 * behaviour that replaced it: arm on the click, write only after a genuine trip
 * away, and stay silent for every trip that did not happen.
 */

const forwardMessageLink = vi.fn();

vi.mock("./runtime", () => ({
  useRuntime: () => ({ api: { forwardMessageLink } }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/** Milliseconds the hook requires away before a return counts. */
const MIN_AWAY_MS = 2500;

let clock = 1_700_000_000_000;
let hidden = false;

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Background the tab the way opening wa.me in a new tab does. */
function goAway(ms: number) {
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  clock += ms;
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.clearAllMocks();
  clock = 1_700_000_000_000;
  hidden = false;
  forwardMessageLink.mockResolvedValue({ status: "recorded", systemMessageId: "sys-1" });
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useWhatsAppForward", () => {
  it("records nothing on the click itself — WhatsApp has not been visited yet", async () => {
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");

    // Give any stray promise a turn before asserting the absence.
    await Promise.resolve();
    expect(forwardMessageLink).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("records the forward once the user has been away and comes back", async () => {
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");
    goAway(30_000);

    await waitFor(() => expect(forwardMessageLink).toHaveBeenCalledTimes(1));
    // No phone number and no name: the recipient was chosen inside WhatsApp and
    // is not knowable here. A clientMsgId IS passed, so a retry dedupes.
    const [messageId, phone, name, clientMsgId] = forwardMessageLink.mock.calls[0]!;
    expect(messageId).toBe("msg-1");
    expect(phone).toBeUndefined();
    expect(name).toBeUndefined();
    expect(clientMsgId).toEqual(expect.any(String));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
  });

  it("stays silent when the user bounces straight back — the WhatsApp login wall", async () => {
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");
    goAway(MIN_AWAY_MS - 500);

    await Promise.resolve();
    expect(forwardMessageLink).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stays silent when the page never leaves the foreground — a blocked popup", async () => {
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");
    clock += 60_000;
    // No visibility or focus change at all: nothing ever opened.
    document.dispatchEvent(new Event("visibilitychange"));

    await Promise.resolve();
    expect(forwardMessageLink).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("disarms after a short bounce, so a later unrelated app-switch writes nothing", async () => {
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");
    goAway(MIN_AWAY_MS - 500);
    // The user now switches to some other app for a while, having never gone to
    // WhatsApp. Inventing a pill here would be worse than missing one.
    goAway(60_000);

    await Promise.resolve();
    expect(forwardMessageLink).not.toHaveBeenCalled();
  });

  it("works on the Electron path, where only window blur/focus fires", async () => {
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");
    // shell.openExternal hands the link to the system browser; the renderer
    // usually stays visibilityState "visible", so this is the only signal.
    window.dispatchEvent(new Event("blur"));
    clock += 30_000;
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(forwardMessageLink).toHaveBeenCalledTimes(1));
  });

  it("records one forward per message however often the menu is clicked", async () => {
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");
    result.current("msg-1");
    result.current("msg-1");
    goAway(30_000);

    await waitFor(() => expect(forwardMessageLink).toHaveBeenCalledTimes(1));
  });

  it("records each of two different messages armed before leaving", async () => {
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");
    result.current("msg-2");
    goAway(30_000);

    await waitFor(() => expect(forwardMessageLink).toHaveBeenCalledTimes(2));
    expect(forwardMessageLink.mock.calls.map((c) => c[0])).toEqual(["msg-1", "msg-2"]);
    // One toast for the trip, not one per message.
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("says the record failed, not the forward — WhatsApp opened either way", async () => {
    forwardMessageLink.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useWhatsAppForward(), { wrapper });

    result.current("msg-1");
    goAway(30_000);

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
