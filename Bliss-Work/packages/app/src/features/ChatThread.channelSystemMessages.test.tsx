/**
 * The channel's own membership notices — "<Creator> created the channel X",
 * "<A>, <B> were added to the channel", "<User> joined the channel" — arrive as
 * ordinary channel messages with kind `channel_created` / `channel_member_added`.
 * They must render as centered SystemPills (no bubble, no message-actions menu),
 * in order, and identically whether the viewer is the creator or someone else.
 *
 * Web and Desktop both render through this ChatThread, so one test covers both.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: {}, config: { kind: "web" } }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: "me", username: "me", displayName: "Me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ChatThread, type ThreadMessage } from "./ChatThread";

const messages: ThreadMessage[] = [
  { id: "m1", senderId: "me", body: "Jordan Doe created the channel project room", kind: "channel_created", at: "2026-10-01T09:00:00Z" },
  { id: "m2", senderId: "me", body: "Zed Zimmer, Amy Adams, Bob Brown were added to the channel", kind: "channel_member_added", at: "2026-10-01T09:00:00Z" },
  { id: "m3", senderId: "peer", body: "Cy Dunn joined the channel", kind: "channel_member_added", at: "2026-10-01T09:05:00Z" },
];

const renderThread = (meId: string, list: ThreadMessage[] = messages) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChatThread threadId="t1" messages={list} meId={meId} onSend={vi.fn()} showSenderNames />
    </QueryClientProvider>,
  );

describe("channel membership system messages", () => {
  it.each(["me", "peer"])("render as centered pills, in order, for viewer %s", (viewer) => {
    renderThread(viewer);
    const pills = messages.map((m) => {
      const pill = screen.getByText(m.body).closest("span.rounded-full");
      expect(pill, `${m.body} is a SystemPill`).not.toBeNull();
      expect(pill!.parentElement!.className).toContain("justify-center");
      return pill!;
    });
    // DOM order == message order.
    for (let i = 1; i < pills.length; i++) {
      expect(pills[i - 1]!.compareDocumentPosition(pills[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // A notice is not a message: nothing to react to, forward or delete.
    expect(screen.queryByRole("button", { name: "Message actions" })).not.toBeInTheDocument();
  });
});

describe("private-channel forward notice", () => {
  // The server authors the body from the forwarder's projected name; the client
  // renders it verbatim, so what is asserted here is placement and shape.
  const notice: ThreadMessage = {
    id: "n1",
    senderId: "fiona",
    senderName: "Fiona Forwarder",
    body: "Fiona Forwarder forwarded a message from this channel",
    kind: "channel_forward_notice",
    at: "2026-10-01T10:00:00Z",
  };
  const list: ThreadMessage[] = [
    { id: "t0", senderId: "peer", senderName: "Mia Member", body: "the launch codes", at: "2026-10-01T09:59:00Z" },
    notice,
  ];

  it.each(["me", "fiona", "peer"])("renders as a centered SystemPill naming the forwarder, for viewer %s", (viewer) => {
    renderThread(viewer, list);
    const pill = screen.getByText(notice.body).closest("span.rounded-full");
    expect(pill, "the notice is a SystemPill").not.toBeNull();
    expect(pill!.parentElement!.className).toContain("justify-center");
    expect(pill!.textContent).toContain("Fiona Forwarder forwarded a message from this channel");
    // Not a bubble: the sender's name is not repeated above it, and there is no
    // actions menu for it. Only the ordinary message above it has one.
    expect(screen.queryAllByText("Fiona Forwarder")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Message actions" })).toHaveLength(1);
  });
});
