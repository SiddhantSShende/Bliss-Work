/**
 * Call links (and URLs generally) rendering as clickable in the unified
 * Inbox's thread view — the same scenario ChatThread.test.tsx already covers
 * for the Chats/Channels screens. `linkifyMessage`'s own splitting/safety
 * rules are covered exhaustively in lib/chatFormat.test.ts against real
 * DOM-free input. What's under test here is that ThreadView's default body
 * cell wires into the same shared `renderMessageBody` helper ChatThread
 * uses, for a message the local user sent and one a peer sent.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadView } from "./ThreadView";

const CALL_URL = "https://communication.rnrtechs.com/join?t=ABC123";

function message(over: Record<string, unknown> = {}) {
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

function renderThread(messages: ReturnType<typeof message>[]) {
  return render(
    <ThreadView
      threadId="thread-1"
      messages={messages}
      meId={ME}
      hasMore={false}
      onLoadMore={() => {}}
      isFetchingPrev={false}
    />,
  );
}

describe("call links in the unified-inbox thread view", () => {
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

  it("opens in a new tab with safe rel attributes — the app-wide external-link convention", () => {
    renderThread([message()]);
    const link = screen.getByRole("link", { name: CALL_URL });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("renders a message with no URL as plain text, with no anchor at all", () => {
    renderThread([message({ body: "just saying hi" })]);
    expect(screen.getByText("just saying hi")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
