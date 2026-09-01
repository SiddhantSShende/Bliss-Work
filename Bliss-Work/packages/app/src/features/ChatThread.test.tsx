/**
 * Call links (and URLs generally) rendering as clickable in the thread.
 *
 * `linkifyMessage`'s own splitting/safety rules are covered exhaustively in
 * lib/chatFormat.test.ts against real DOM-free input. What's under test here
 * is the wiring: does ChatThread actually turn a link segment into a real
 * anchor with the join URL as its href, for a message ANY caller could hand
 * it — a message the local user sent, one a peer sent, and one that was
 * already sitting in history before this render (all three are the exact
 * same `ThreadMessage[]` shape, so there is nothing surface-specific to fake).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ChatThread resolves sender avatars via useUserLabels, which needs
// useRuntime() — see ChatsList.test.tsx for the same pattern. Not under test
// here (that's userLabel.test.tsx's job); this just keeps the component from
// throwing "useRuntime outside RuntimeProvider" while rendering.
const api = { directory: vi.fn().mockResolvedValue([]) };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));

import { ChatThread, type ThreadMessage } from "./ChatThread";

const CALL_URL = "https://communication.rnrtechs.com/join?t=ABC123";

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m1",
    senderId: "peer-1",
    senderName: "Alice",
    body: `Join my call: ${CALL_URL}`,
    at: new Date(0).toISOString(),
    ...over,
  };
}

const ME = "me-1";

function renderThread(messages: ThreadMessage[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChatThread threadId="conv-1" messages={messages} meId={ME} onSend={() => {}} peerName="Alice" />
    </QueryClientProvider>,
  );
}

describe("call links in the chat thread", () => {
  it("renders a received message's call link as a real anchor to the join URL", () => {
    renderThread([message({ senderId: "peer-1" })]);
    const link = screen.getByRole("link", { name: CALL_URL });
    expect(link).toHaveAttribute("href", CALL_URL);
  });

  it("renders a sent message's call link the same way", () => {
    renderThread([message({ senderId: ME })]);
    const link = screen.getByRole("link", { name: CALL_URL });
    expect(link).toHaveAttribute("href", CALL_URL);
  });

  it("renders a link for a message that was already in history on first render — nothing depends on it having just arrived", () => {
    // Nothing about ChatThread distinguishes "just sent/received" from
    // "loaded on mount": both are just entries in the `messages` prop it is
    // handed. This is the same call as the tests above, asserted again to
    // make that equivalence explicit rather than assumed.
    renderThread([
      message({ id: "old-1", senderId: "peer-1", at: new Date(-86_400_000).toISOString() }),
    ]);
    expect(screen.getByRole("link", { name: CALL_URL })).toHaveAttribute("href", CALL_URL);
  });

  it("opens in a new tab with safe rel attributes — the app-wide external-link convention", () => {
    renderThread([message()]);
    const link = screen.getByRole("link", { name: CALL_URL });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("leaves the surrounding text intact around the link", () => {
    renderThread([message({ body: `Join my call: ${CALL_URL}` })]);
    expect(screen.getByText("Join my call:", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: CALL_URL })).toBeInTheDocument();
  });

  it("linkifies an ordinary URL too, not only a BlissWork call link", () => {
    renderThread([message({ body: "see https://example.org/anything?a=1" })]);
    const link = screen.getByRole("link", { name: "https://example.org/anything?a=1" });
    expect(link).toHaveAttribute("href", "https://example.org/anything?a=1");
  });

  it("renders a message with no URL as plain text, with no anchor at all", () => {
    renderThread([message({ body: "just saying hi" })]);
    expect(screen.getByText("just saying hi")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("never turns malicious content into markup — a <script>-bearing body renders as inert text, and any URL in it stops before the injection characters", () => {
    const malicious = 'go to https://example.com/x"><script>alert(1)</script> now';
    const { container } = renderThread([message({ body: malicious })]);

    // The link is truncated at the quote — it can never carry the injected
    // markup into its href.
    const link = screen.getByRole("link", { name: "https://example.com/x" });
    expect(link).toHaveAttribute("href", "https://example.com/x");

    // No <script> element was ever created — the text is inert, not parsed.
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

/**
 * Selection mode: the per-message actions row is replaced by a selection
 * indicator, and normal actions must not fire from a bubble click while it is
 * active. Both guarantees are structural (MessageActions is conditionally
 * unmounted, not merely intercepted) — see ChatThread's own comments on why.
 */
describe("ChatThread — selection mode", () => {
  function renderSelectable(messages: ThreadMessage[], onToggleSelect = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
      <QueryClientProvider client={qc}>
        <ChatThread
          threadId="conv-1"
          messages={messages}
          meId={ME}
          onSend={() => {}}
          peerName="Alice"
          selectionMode
          selectedIds={new Set()}
          onToggleSelect={onToggleSelect}
        />
      </QueryClientProvider>,
    );
    return { ...utils, onToggleSelect, user: userEvent.setup() };
  }

  it("renders no per-message actions trigger while selecting", () => {
    renderSelectable([message()]);
    expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
  });

  it("restores the normal actions trigger once selection mode is off", () => {
    renderThread([message()]);
    expect(screen.getByRole("button", { name: "Message actions" })).toBeInTheDocument();
  });

  it("toggles selection by the message's stable id when its row is clicked", async () => {
    const { user, onToggleSelect } = renderSelectable([message({ id: "msg-abc" })]);
    await user.click(screen.getByRole("button", { name: /Select message/ }));
    expect(onToggleSelect).toHaveBeenCalledWith("msg-abc");
  });

  it("offers no selection control for a pending (unsent) message", () => {
    renderSelectable([message({ id: "temp:1", pending: true })]);
    expect(screen.queryByRole("button", { name: /Select message/ })).toBeNull();
  });

  it("offers no selection control for a message already deleted for everyone", () => {
    renderSelectable([message({ deletedForAll: true, body: "" })]);
    expect(screen.queryByRole("button", { name: /Select message/ })).toBeNull();
  });
});
