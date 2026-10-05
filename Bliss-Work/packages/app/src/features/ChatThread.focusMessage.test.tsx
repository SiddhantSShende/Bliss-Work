/**
 * Landing on a notification's message: scroll to it, highlight it, and — when it
 * is older than the page held — page backwards until it turns up, without ever
 * walking a whole history for a message that is not there.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: {}, config: { kind: "web" } }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: "me", username: "me", displayName: "Me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ChatThread, type ThreadMessage } from "./ChatThread";

const msg = (id: string, body = id): ThreadMessage => ({ id, senderId: "peer", senderName: "Peer", body, at: "2026-10-01T09:00:00Z" });
const TARGET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function mount(props: Partial<React.ComponentProps<typeof ChatThread>> & { messages: ThreadMessage[] }) {
  const ui = (p: typeof props) => (
    <QueryClientProvider client={new QueryClient()}>
      <ChatThread threadId="t1" meId="me" onSend={vi.fn()} showSenderNames {...p} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return { ...view, update: (next: typeof props) => view.rerender(ui(next)) };
}

describe("ChatThread focusMessageId", () => {
  it("highlights a loaded message, scrolls to it, and reports it handled once", () => {
    const onFocusHandled = vi.fn();
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    const { container } = mount({ messages: [msg("a"), msg(TARGET), msg("z")], focusMessageId: TARGET, onFocusHandled });
    const row = container.querySelector(`[data-message-id="${TARGET}"]`)!;
    expect(row.innerHTML).toContain("ring-accent");
    expect(container.querySelector('[data-message-id="a"]')!.innerHTML).not.toContain("ring-accent");
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalled();
    scrollTo.mockRestore();
  });

  it("does nothing without a focus target", () => {
    const onLoadOlder = vi.fn();
    const onFocusHandled = vi.fn();
    mount({ messages: [msg("a")], hasOlder: true, onLoadOlder, onFocusHandled });
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(onFocusHandled).not.toHaveBeenCalled();
  });

  it("fetches older history while the message is missing, then lands on it", () => {
    const onLoadOlder = vi.fn();
    const onFocusHandled = vi.fn();
    const { update, container } = mount({
      messages: [msg("m2"), msg("m3")], hasOlder: true, onLoadOlder, onFocusHandled, focusMessageId: TARGET,
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onFocusHandled).not.toHaveBeenCalled();

    update({ messages: [msg(TARGET), msg("m2"), msg("m3")], hasOlder: true, onLoadOlder, onFocusHandled, focusMessageId: TARGET });
    expect(container.querySelector(`[data-message-id="${TARGET}"]`)!.innerHTML).toContain("ring-accent");
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not ask for another page while one is in flight", () => {
    const onLoadOlder = vi.fn();
    mount({ messages: [msg("a")], hasOlder: true, loadingOlder: true, onLoadOlder, focusMessageId: TARGET });
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("gives up, and says so, once history runs out without the message", () => {
    const onLoadOlder = vi.fn();
    const onFocusHandled = vi.fn();
    mount({ messages: [msg("a")], hasOlder: false, onLoadOlder, onFocusHandled, focusMessageId: TARGET });
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
  });

  it("stops paging after a bounded number of pages", () => {
    const onLoadOlder = vi.fn();
    const onFocusHandled = vi.fn();
    const props = { hasOlder: true, onLoadOlder, onFocusHandled, focusMessageId: TARGET };
    const { update } = mount({ ...props, messages: [msg("p0")] });
    for (let page = 1; page <= 30; page++) update({ ...props, messages: [msg(`p${page}`), msg("p0")] });
    expect(onLoadOlder.mock.calls.length).toBeLessThanOrEqual(20);
    expect(onFocusHandled).toHaveBeenCalled();
  });
});
