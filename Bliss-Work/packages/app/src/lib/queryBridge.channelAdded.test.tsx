/**
 * What the socket bridge does when someone is added to a channel.
 *
 * Two surfaces, one source: the persisted CHANNEL_ADDED notification feeds the
 * bell row, the unread badge AND the live toast. The older channel.member.joined
 * event still refreshes the sidebar but must no longer toast on its own — with
 * both, one add would show the user two toasts.
 *
 * The bridge is mounted for real and events are delivered through it; the
 * assertions are on the query cache and on what sonner was asked to show.
 */
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type NotificationDTO, type ServerEvent, type WsEventMeta } from "@taskboard/shared";
import { INVALIDATE_WINDOW_MS } from "./coalesceInvalidations";
import { qk } from "./queryKeys";
import type { NotificationPages } from "./notificationPages";
import { WsEventBridge } from "./queryBridge";

const ws = vi.hoisted(() => ({
  emit: undefined as ((e: unknown, meta?: WsEventMeta) => void) | undefined,
}));
interface ShownToast {
  message: string;
  options?: { id?: string; action?: { label: string; onClick: () => void } };
}
const toasts = vi.hoisted(() => ({ shown: [] as ShownToast[] }));

// A stand-in that, like sonner, treats a repeated `id` as the same toast.
vi.mock("sonner", () => {
  const record = (message: string, options?: ShownToast["options"]) => {
    if (options?.id && toasts.shown.some((t) => t.options?.id === options.id)) return;
    toasts.shown.push({ message, options });
  };
  return {
    toast: Object.assign(record, { info: record, error: record, success: record }),
  };
});

vi.mock("./runtime", () => ({
  useRuntime: () => ({
    config: {},
    api: { markNotificationRead: () => Promise.resolve() },
    ws: {
      connect: () => Promise.resolve(),
      close: () => {},
      on: (cb: (e: unknown, meta?: WsEventMeta) => void) => {
        ws.emit = cb;
        return () => {};
      },
    },
  }),
}));

const ME = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const OTHER_CHANNEL = "99999999-9999-4999-8999-999999999999";
const NOTIFICATION = "44444444-4444-4444-8444-444444444444";
const EVENT = "55555555-5555-4555-8555-555555555555";
const ORG = "66666666-6666-4666-8666-666666666666";
const TEXT = "Jordan Doe added you to the channel project room";

vi.mock("../store/session", () => ({
  useSession: Object.assign(
    (sel: (s: { user: { id: string; orgId: string } }) => unknown) =>
      sel({ user: { id: ME, orgId: "org" } }),
    { getState: () => ({ user: { id: ME, orgId: "org" } }) },
  ),
}));

function LocationProbe() {
  return (
    <>
      <div data-testid="path">{useLocation().pathname}</div>
      <div data-testid="nav-type">{useNavigationType()}</div>
    </>
  );
}

let qc: QueryClient;

function mount(entries: string[] = ["/app/tasks"]) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const existing: NotificationDTO = {
    id: "77777777-7777-4777-8777-777777777777",
    kind: "TASK_ASSIGNED",
    text: "New task from Priya",
    taskId: "88888888-8888-4888-8888-888888888888",
    read: false,
    createdAt: "2026-09-30T10:00:00.000Z",
  };
  qc.setQueryData<NotificationPages>(qk.notifications, {
    pages: [{ items: [existing], nextCursor: null }],
    pageParams: [undefined],
  });
  qc.setQueryData(qk.notificationsUnreadCount, { unreadCount: 1 });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <WsEventBridge />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Deliver an event, then let the bridge's coalesced invalidation window pass. */
const fire = (e: ServerEvent, meta?: WsEventMeta) =>
  act(() => {
    ws.emit?.(e, meta);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS);
  });

function channelAdded(over: Record<string, unknown> = {}): ServerEvent {
  return {
    type: EventType.NotificationCreated,
    eventId: EVENT,
    occurredAt: "2026-10-01T12:00:00.000Z",
    orgId: ORG,
    notificationId: NOTIFICATION,
    recipientId: ME,
    kind: "CHANNEL_ADDED",
    text: TEXT,
    channelId: CHANNEL,
    ...over,
  } as ServerEvent;
}

const bell = () => qc.getQueryData<NotificationPages>(qk.notifications)?.pages.flatMap((p) => p.items) ?? [];
const unread = () => qc.getQueryData<{ unreadCount: number }>(qk.notificationsUnreadCount)?.unreadCount;

beforeEach(() => {
  toasts.shown = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WsEventBridge — CHANNEL_ADDED notification", () => {
  it("adds a bell row and bumps the unread count", () => {
    mount();
    fire(channelAdded());

    const row = bell().find((n) => n.id === NOTIFICATION);
    expect(row).toMatchObject({ kind: "CHANNEL_ADDED", text: TEXT, channelId: CHANNEL, read: false });
    expect(unread()).toBe(2);
  });

  it("toasts the same text the bell shows, as soon as it arrives live", () => {
    mount();
    fire(channelAdded());

    expect(toasts.shown).toHaveLength(1);
    expect(toasts.shown[0]?.message).toBe(TEXT);
  });

  it("opens the channel when the toast's action is clicked", () => {
    mount();
    fire(channelAdded());
    expect(screen.getByTestId("path").textContent).toBe("/app/tasks");

    const action = toasts.shown[0]?.options?.action;
    expect(action?.label).toBe("View");
    act(() => action?.onClick());

    expect(screen.getByTestId("path").textContent).toBe(`/app/channels/${CHANNEL}`);
  });

  it("keeps the bell row and badge for a replayed frame but raises no toast", () => {
    mount();
    fire(channelAdded(), { replayed: true });

    expect(toasts.shown).toEqual([]);
    expect(bell().some((n) => n.id === NOTIFICATION)).toBe(true);
    expect(unread()).toBe(2);
  });

  it("does not toast, or count, the same notification twice", () => {
    mount();
    fire(channelAdded());
    fire(channelAdded({ eventId: "99999999-9999-4999-8999-999999999999" }));

    expect(toasts.shown).toHaveLength(1);
    expect(bell().filter((n) => n.id === NOTIFICATION)).toHaveLength(1);
    expect(unread()).toBe(2);
  });

  it("does not toast live after the same notification already arrived in a replay", () => {
    mount();
    fire(channelAdded(), { replayed: true });
    fire(channelAdded());

    expect(toasts.shown).toEqual([]);
  });

  it("ignores a notification addressed to someone else", () => {
    mount();
    fire(channelAdded({ recipientId: ACTOR }));

    expect(toasts.shown).toEqual([]);
    expect(bell().some((n) => n.id === NOTIFICATION)).toBe(false);
    expect(unread()).toBe(1);
  });

  it("leaves other notification kinds without a toast", () => {
    mount();
    fire(channelAdded({ kind: "CHANNEL_MESSAGE", text: "Priya in #design: hi" }));
    fire(
      channelAdded({
        notificationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "DM_MESSAGE",
        text: "Priya: hello",
        channelId: undefined,
      }),
    );

    expect(toasts.shown).toEqual([]);
    expect(unread()).toBe(3);
  });

  it("shows no toast of its own for channel.member.joined, which would double the notification's", () => {
    mount();
    fire({
      type: EventType.ChannelMemberJoined,
      eventId: EVENT,
      occurredAt: "2026-10-01T12:00:00.000Z",
      orgId: ORG,
      channelId: CHANNEL,
      channelName: "project room",
      userId: ME,
      username: "me",
      actorId: ACTOR,
    } as ServerEvent);

    expect(toasts.shown).toEqual([]);
  });
});

describe("WsEventBridge — CHANNEL_ADDED toast navigation", () => {
  const path = () => screen.getByTestId("path").textContent;
  const view = (index = 0) => {
    const action = toasts.shown[index]?.options?.action;
    expect(action?.label).toBe("View");
    act(() => action?.onClick());
  };

  it("View opens the notification's channel while another channel is open", () => {
    mount([`/app/channels/${OTHER_CHANNEL}`]);
    fire(channelAdded());
    expect(path()).toBe(`/app/channels/${OTHER_CHANNEL}`);

    view();

    expect(path()).toBe(`/app/channels/${CHANNEL}`);
  });

  it("View opens the channel from the Settings page", () => {
    mount(["/app/settings"]);
    fire(channelAdded());

    view();

    expect(path()).toBe(`/app/channels/${CHANNEL}`);
  });

  it("each toast opens its own channel, whatever was opened or toasted before", () => {
    const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mount(["/app/settings"]);
    fire(channelAdded());
    fire(channelAdded({ notificationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", channelId: second }));

    view(1);
    expect(path()).toBe(`/app/channels/${second}`);
    view(0);
    expect(path()).toBe(`/app/channels/${CHANNEL}`);
    view(1);
    expect(path()).toBe(`/app/channels/${second}`);
  });

  it("judges 'already open' by where the user is when they click, not when the toast appeared", () => {
    // The toast appears while the user is on Settings; the first click moves the
    // router to the channel. A second click must then see it is already there.
    mount(["/app/settings"]);
    fire(channelAdded());

    view();
    expect(path()).toBe(`/app/channels/${CHANNEL}`);
    expect(screen.getByTestId("nav-type").textContent).toBe("PUSH");

    view();
    expect(path()).toBe(`/app/channels/${CHANNEL}`);
    expect(screen.getByTestId("nav-type").textContent).toBe("REPLACE");
  });

  it("replaces rather than stacks a history entry when the channel is already open", () => {
    mount(["/app/settings", `/app/channels/${CHANNEL}`]);
    fire(channelAdded());

    view();

    expect(path()).toBe(`/app/channels/${CHANNEL}`);
    expect(screen.getByTestId("nav-type").textContent).toBe("REPLACE");
  });

  it("builds the route from channelId, never from the notification's text", () => {
    mount(["/app/settings"]);
    fire(channelAdded({ text: `Mallory added you to the channel /app/channels/${OTHER_CHANNEL}` }));

    view();

    expect(path()).toBe(`/app/channels/${CHANNEL}`);
  });

  it("offers no View for a record with no usable channel id", () => {
    mount(["/app/settings"]);
    fire(channelAdded({ channelId: undefined }));

    expect(toasts.shown[0]?.options?.action).toBeUndefined();
  });
});
