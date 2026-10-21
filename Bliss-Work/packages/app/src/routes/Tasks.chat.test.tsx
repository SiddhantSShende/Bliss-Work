import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionsFor, type AssigneeStatus, type StickyTaskDTO } from "@taskboard/shared";
import { useSession } from "../store/session";

const ME = "33333333-3333-4333-8333-333333333333";
const SENDER = "00000000-0000-4000-8000-000000000001";
const AXEBOM_CHANNEL = "cccccccc-0000-4000-8000-0000000000c1";
const TASK_WITH_CHANNEL = "aaaaaaaa-0000-4000-8000-000000000001";
const TASK_WITHOUT_CHANNEL = "aaaaaaaa-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  api: {
    taskAssigned: vi.fn(),
    taskAction: vi.fn(),
    stickyPinStates: vi.fn(),
    openTaskDiscussion: vi.fn(),
    openSelfChat: vi.fn(),
  },
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: mocks.api, config: { kind: "web" } }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
// openDiscussion's DM branch (useSelectedChat) is not under test here — only
// channel resolution/navigation is — so a plain stub is enough.
vi.mock("../lib/selectedChat", () => ({ useSelectedChat: () => ({ openChat: vi.fn() }) }));

import { Tasks } from "./Tasks";

/** A channel page stand-in — renders the two things the Chat button must get
 *  right: WHICH channel (the :channelId param) and WHICH task (?taskId=). */
function ChannelStub() {
  const { channelId } = useParams();
  const [params] = useSearchParams();
  return (
    <div data-testid="channel-stub">
      channel:{channelId} task:{params.get("taskId")}
    </div>
  );
}

function task(id: string, title: string, status: AssigneeStatus, channelId?: string): StickyTaskDTO {
  return {
    taskId: id,
    orgId: "00000000-0000-4000-8000-000000000002",
    title,
    description: "",
    channelId: channelId ?? null,
    senderId: SENDER,
    senderUsername: "sender",
    myStatus: status,
    actions: actionsFor(status),
    statusVersion: 1,
    participants: [],
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
  } as StickyTaskDTO;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/tasks/allocated"]}>
        <Routes>
          <Route path="/app/tasks/:view" element={<Tasks />} />
          <Route path="/app/channels/:channelId" element={<ChannelStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

function card(title: string): HTMLElement {
  const chatBtn = (el: HTMLElement) => within(el).queryAllByRole("button", { name: /chat/i }).length;
  let el: HTMLElement = screen.getByText(title);
  while (el.parentElement && chatBtn(el) === 0) el = el.parentElement;
  while (el.parentElement && chatBtn(el.parentElement) === 1) el = el.parentElement;
  if (chatBtn(el) !== 1) throw new Error(`no card with a chat control for "${title}"`);
  return el;
}
const chatButton = (title: string) => within(card(title)).getByRole("button", { name: /chat/i });

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ status: "authed", user: { id: ME } } as never);
  mocks.api.taskAssigned.mockResolvedValue([
    task(TASK_WITH_CHANNEL, "Fix the WCAG issue", "ACKNOWLEDGED", AXEBOM_CHANNEL),
    task(TASK_WITHOUT_CHANNEL, "Draft the memo", "ACKNOWLEDGED"),
  ]);
  mocks.api.stickyPinStates.mockResolvedValue({ pinned: [], unpinned: [TASK_WITH_CHANNEL, TASK_WITHOUT_CHANNEL] });
  mocks.api.openTaskDiscussion.mockResolvedValue({ id: "d1", kind: "CHANNEL", channelId: AXEBOM_CHANNEL });
});

describe("Allocated to me — Chat button navigation", () => {
  it("opens the task's own channel, not a DM, when the task has one", async () => {
    mount();
    await screen.findByText("Fix the WCAG issue");

    fireEvent.click(chatButton("Fix the WCAG issue"));

    await waitFor(() =>
      expect(mocks.api.openTaskDiscussion).toHaveBeenCalledWith(TASK_WITH_CHANNEL, { channelId: AXEBOM_CHANNEL }),
    );
    const stub = await screen.findByTestId("channel-stub");
    expect(stub).toHaveTextContent(`channel:${AXEBOM_CHANNEL}`);
    expect(stub).toHaveTextContent(`task:${TASK_WITH_CHANNEL}`);
  });

  it("falls back to a DM with the sender when the task has no channel, never an arbitrary one", async () => {
    mount();
    await screen.findByText("Draft the memo");

    fireEvent.click(chatButton("Draft the memo"));

    await waitFor(() =>
      expect(mocks.api.openTaskDiscussion).toHaveBeenCalledWith(TASK_WITHOUT_CHANNEL, { peerId: SENDER }),
    );
    expect(screen.queryByTestId("channel-stub")).not.toBeInTheDocument();
  });
});
