/**
 * Forwarding to WhatsApp by deep link.
 *
 * What is worth pinning here is the set of properties a refactor would quietly
 * break, each of which turns the feature into something that silently does
 * nothing:
 *
 *  - the control is an ANCHOR, not a scripted window.open. A user-initiated
 *    anchor is never popup-blocked, and in Electron it routes through
 *    setWindowOpenHandler → safeExternalUrl → shell.openExternal instead of
 *    opening a renderer window.
 *  - navigation is never gated on the POST. A slow or failing "record the
 *    forward" call must not stop WhatsApp from opening.
 *  - the number sent to the server is the NORMALIZED one, so the recorded
 *    forward matches the chat that was actually opened.
 *  - the manual form is the default. navigator.contacts is Chrome-on-Android
 *    only, so for nearly every user it is the ONLY path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = { forwardMessageLink: vi.fn() };

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "web" } }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { WhatsAppForward } from "./WhatsAppForward";

function renderIt(body = "ship it") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onDone = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <WhatsAppForward sourceMessageId="msg-1" sourceBody={body} onDone={onDone} />
    </QueryClientProvider>,
  );
  return { ...utils, onDone };
}

const link = () => screen.getByRole("link", { name: /Open WhatsApp/i });

beforeEach(() => {
  vi.clearAllMocks();
  api.forwardMessageLink.mockResolvedValue({
    status: "recorded",
    platform: "whatsapp",
    delivery: "unconfirmed",
    targetPhone: "15550192834",
    systemMessageId: "sys-1",
  });
});

describe("WhatsAppForward", () => {
  it("shows the manual form and no contact picker when navigator.contacts is absent", () => {
    renderIt();
    expect(screen.getByLabelText("Phone number")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Choose from contacts/i })).toBeNull();
  });

  it("offers the picker when the Contact Picker API exists", () => {
    vi.stubGlobal("isSecureContext", true);
    Object.defineProperty(navigator, "contacts", {
      value: { select: vi.fn() },
      configurable: true,
    });
    try {
      renderIt();
      expect(screen.getByRole("button", { name: /Choose from contacts/i })).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator as object, "contacts");
      vi.unstubAllGlobals();
    }
  });

  it("keeps the link inert until the number is usable, and explains why", async () => {
    const user = userEvent.setup();
    renderIt();

    expect(link()).not.toHaveAttribute("href");

    await user.type(screen.getByLabelText("Phone number"), "0192834");
    expect(link()).not.toHaveAttribute("href");
    expect(screen.getByText(/Include the country code/i)).toBeInTheDocument();
  });

  it("builds a wa.me href from the NORMALIZED number and the message text", async () => {
    const user = userEvent.setup();
    renderIt("ship it");

    await user.type(screen.getByLabelText("Phone number"), "+1 (555) 019-2834");

    expect(link()).toHaveAttribute("href", "https://wa.me/15550192834?text=ship%20it");
  });

  it("records the forward with the normalized number on click", async () => {
    const user = userEvent.setup();
    const { onDone } = renderIt();

    await user.type(screen.getByLabelText("Phone number"), "+1 (555) 019-2834");
    await user.type(screen.getByLabelText(/Name/i), "Jane Doe");
    await user.click(link());

    expect(api.forwardMessageLink).toHaveBeenCalledWith("msg-1", "15550192834", "Jane Doe");
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("still exposes the link when recording fails — WhatsApp opened regardless", async () => {
    const user = userEvent.setup();
    api.forwardMessageLink.mockRejectedValue(new Error("offline"));
    const { onDone } = renderIt();

    await user.type(screen.getByLabelText("Phone number"), "15550192834");
    await user.click(link());

    await vi.waitFor(() => expect(api.forwardMessageLink).toHaveBeenCalled());
    // The dialog stays open (nothing was recorded) but the href is untouched,
    // so the navigation the click already started was never blocked.
    expect(onDone).not.toHaveBeenCalled();
    expect(link()).toHaveAttribute("href", "https://wa.me/15550192834?text=ship%20it");
  });

  it("does not record twice when the link is clicked twice", async () => {
    const user = userEvent.setup();
    renderIt();

    await user.type(screen.getByLabelText("Phone number"), "15550192834");
    await user.click(link());
    await user.click(link());

    expect(api.forwardMessageLink).toHaveBeenCalledTimes(1);
  });
});
