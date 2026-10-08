/**
 * "New message" notifications name who wrote and — for a channel — where, instead of
 * showing the message text or a placeholder. Every other kind is drawn exactly as before.
 *
 * Names come from the conversation / channel lists the app already holds (by the record's
 * conversationId / channelId), then from the producer's snapshot in `text`, then a fallback.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ChannelDTO, ConversationDTO, NotificationDTO } from "@taskboard/shared";
import { qk } from "../lib/queryKeys";
import { NotificationsPanel } from "./NotificationsPanel";

const api = { markNotificationRead: vi.fn(async () => {}), notificationsUnreadCount: vi.fn(async () => ({ unreadCount: 0 })) };
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));

const CHAT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FEED = { loading: false, hasNextPage: false, isFetchingNextPage: false, loadMore: () => {} };

let n = 0;
const note = (kind: string, text: string, over: Partial<NotificationDTO> = {}): NotificationDTO => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  kind,
  text,
  taskId: null,
  read: false,
  createdAt: "2026-10-06T09:05:00.000Z",
  ...over,
});
const dm = (text: string, over: Partial<NotificationDTO> = {}) => note("DM_MESSAGE", text, { conversationId: CHAT, ...over });
const channelMsg = (text: string, over: Partial<NotificationDTO> = {}) => note("CHANNEL_MESSAGE", text, { channelId: CHANNEL, ...over });

function mount(
  notifications: NotificationDTO[],
  cache: { conversations?: Partial<ConversationDTO>[]; channels?: Partial<ChannelDTO>[] } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cache.conversations) qc.setQueryData(qk.conversations, cache.conversations);
  if (cache.channels) qc.setQueryData(qk.channels, cache.channels);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NotificationsPanel open onClose={() => {}} notifications={notifications} unreadFeed={FEED} readFeed={FEED} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const items = () => within(screen.getByRole("dialog")).getAllByRole("listitem");
const lines = (li: HTMLElement) => Array.from(li.querySelectorAll("button > span > span")).map((el) => el.textContent);

describe("a direct message", () => {
  it("shows the sender's display name, resolved from the cached conversation", () => {
    mount([dm("New message: Lunch at one?")], { conversations: [{ id: CHAT, peerUsername: "j.smith", peerDisplayName: "John Smith" }] });

    expect(lines(items()[0]!)).toEqual(["New message", "John Smith", "You have a new message"]);
  });

  it("does not show the message text, an email address or an id", () => {
    mount([dm("john@example.com: secret plans", { messageId: CHAT })], { conversations: [{ id: CHAT, peerUsername: "john", peerDisplayName: "John Smith" }] });

    const text = items()[0]!.textContent!;
    expect(text).not.toContain("secret plans");
    expect(text).not.toContain("@");
    expect(text).not.toContain(CHAT);
  });

  it("uses the name the producer wrote when the conversation is not cached", () => {
    mount([dm("Priya Shah: hi")]);

    expect(lines(items()[0]!)).toEqual(["New message", "Priya Shah", "You have a new message"]);
  });

  it("falls back to 'Someone' when nothing names the sender (the producer's placeholder, no cache)", () => {
    mount([dm("New message: Lunch at one?")]);

    expect(lines(items()[0]!)).toEqual(["New message", "Someone", "You have a new message"]);
  });
});

describe("a channel message", () => {
  it("shows the sender's display name and the channel name", () => {
    mount([channelMsg("John Smith in #Engineering: ship it")], { channels: [{ id: CHANNEL, name: "Engineering" }] });

    expect(lines(items()[0]!)).toEqual(["New message", "John Smith · #Engineering", "You have a new message"]);
  });

  it("takes the channel's current name from the channel list, by id", () => {
    mount([channelMsg("John Smith in #old-name: ship it")], { channels: [{ id: CHANNEL, name: "Engineering" }] });

    expect(lines(items()[0]!)[1]).toBe("John Smith · #Engineering");
  });

  it("uses the snapshot in the text for a channel the user can no longer see", () => {
    mount([channelMsg("John Smith in #Engineering: ship it")], { channels: [] });

    expect(lines(items()[0]!)[1]).toBe("John Smith · #Engineering");
  });

  it("falls back to 'a channel' when no channel name exists anywhere, keeping the sender", () => {
    mount([channelMsg("Alloc Owner in a channel: Review is ready")]);

    expect(lines(items()[0]!)).toEqual(["New message", "Alloc Owner · a channel", "You have a new message"]);
  });

  it("falls back to 'Someone · a channel' when neither is known", () => {
    mount([channelMsg("New message in a channel: hi")]);

    expect(lines(items()[0]!)[1]).toBe("Someone · a channel");
  });
});

describe("every other kind is untouched", () => {
  const others: [string, string][] = [
    ["TASK_ASSIGNED", "New task from Priya: Report"],
    ["TASK_COMPLETED", "Task completed by Divya"],
    ["CHANNEL_ADDED", "Priya added you to the channel design"],
    ["CHANNEL_CREATED", "Priya created channel design"],
    ["MEETING_SCHEDULED", "Meeting scheduled: Standup"],
    ["MEETING_INVITATION", "Meeting invitation: Standup"],
    ["SOMETHING_NEW", "Some: text with a colon in #hash"],
  ];

  it.each(others)("%s shows its own text, whole, with no sender line", (kind, text) => {
    mount([note(kind, text, { conversationId: CHAT, channelId: CHANNEL })], {
      conversations: [{ id: CHAT, peerDisplayName: "John Smith" }],
      channels: [{ id: CHANNEL, name: "Engineering" }],
    });

    const li = items()[0]!;
    expect(within(li).getByText(text)).toBeInTheDocument();
    expect(li.textContent).not.toContain("You have a new message");
    expect(li.textContent).not.toContain("John Smith");
  });
});

describe("the row", () => {
  it("sets the sender line apart from the title and the body, in one row", () => {
    mount([dm("Priya Shah: hi")]);

    const [title, sender, body] = Array.from(items()[0]!.querySelectorAll("button > span > span")) as HTMLElement[];
    expect(title!.className).toContain("font-semibold");
    expect(sender!.className).toContain("text-accent");
    expect(body!.className).toContain("text-muted");
    expect(sender!.className).not.toBe(title!.className);
  });

  it("does not truncate a long name or channel name", () => {
    const name = "Bartholomew Wolfeschlegelsteinhausenbergerdorff ".repeat(3).trim();
    const channel = "a-very-long-channel-name-".repeat(6);
    mount([channelMsg(`${name} in #${channel}: hi`)]);

    const li = items()[0]!;
    expect(li.textContent).toContain(`${name} · #${channel}`);
    expect(li.innerHTML).not.toMatch(/truncate|line-clamp|text-ellipsis/);
    expect(li.querySelector("button > span")!.className).toContain("break-words");
  });

  it("keeps the timestamp and the Mark read action", () => {
    mount([dm("Priya Shah: hi")]);

    const li = items()[0]!;
    expect(li.textContent).toMatch(/2026|10\/6|6\/10|06/);
    expect(within(li).getByRole("button", { name: "Mark read" })).toBeInTheDocument();
  });
});
