/**
 * Auto-scroll on new messages: pin the reader to the bottom only when they are
 * already there or the message is their own; never because a pending send's
 * temp id was swapped for the real one.
 *
 * jsdom has no layout, so the geometry is faked: a 1000px list in a 400px
 * viewport, whose scrollTop the tests set the way a scroll gesture would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: {}, config: { kind: "web" } }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: "me", username: "me", displayName: "Me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ChatThread, type ThreadMessage } from "./ChatThread";

const msg = (id: string, senderId = "peer"): ThreadMessage => ({
  id,
  senderId,
  senderName: senderId,
  body: id,
  at: "2026-10-01T09:00:00Z",
});

const tops = new WeakMap<Element, number>();
let scrollTo: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return tops.get(this) ?? 0;
    },
    set(v: number) {
      tops.set(this, v);
    },
  });
  scrollTo = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  scrollTo.mockRestore();
  // @ts-expect-error restore jsdom defaults (own props shadowed on the prototype)
  delete HTMLElement.prototype.scrollHeight;
  // @ts-expect-error see above
  delete HTMLElement.prototype.clientHeight;
  // @ts-expect-error see above
  delete HTMLElement.prototype.scrollTop;
});

function mount(messages: ThreadMessage[]) {
  const ui = (m: ThreadMessage[]) => (
    <QueryClientProvider client={new QueryClient()}>
      <ChatThread threadId="t1" meId="me" onSend={vi.fn()} showSenderNames messages={m} />
    </QueryClientProvider>
  );
  const view = render(ui(messages));
  const list = view.container.querySelector<HTMLElement>(".overflow-auto")!;
  const scrollTo_ = (top: number) => fireEvent.scroll(list, { target: { scrollTop: top } });
  return { update: (m: ThreadMessage[]) => view.rerender(ui(m)), scrollTo_ };
}

describe("ChatThread auto-scroll on new messages", () => {
  it("follows a peer's message when the reader is at the bottom", () => {
    const { update, scrollTo_ } = mount([msg("a"), msg("b")]);
    scrollTo_(600); // 1000 - 600 - 400 = 0 from the bottom
    scrollTo.mockClear();
    update([msg("a"), msg("b"), msg("c")]);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("leaves a reader who scrolled up alone when a peer's message arrives", () => {
    const { update, scrollTo_ } = mount([msg("a"), msg("b")]);
    scrollTo_(100); // 500px from the bottom
    scrollTo.mockClear();
    update([msg("a"), msg("b"), msg("c")]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("still scrolls to the bottom for the reader's own new message", () => {
    const { update, scrollTo_ } = mount([msg("a"), msg("b")]);
    scrollTo_(100);
    scrollTo.mockClear();
    update([msg("a"), msg("b"), msg("temp:1", "me")]);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("does not scroll when a pending send's temp id is swapped for the real id", () => {
    const { update, scrollTo_ } = mount([msg("a"), msg("b")]);
    update([msg("a"), msg("b"), msg("temp:1", "me")]);
    scrollTo_(100); // reader scrolls up while the send is in flight
    scrollTo.mockClear();
    update([msg("a"), msg("b"), msg("real-1", "me")]);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
