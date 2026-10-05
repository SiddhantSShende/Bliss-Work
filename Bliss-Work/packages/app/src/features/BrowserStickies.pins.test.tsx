import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actionsFor, ApiError, type StickyTaskDTO } from "@taskboard/shared";
import { qk } from "../lib/queryKeys";
import { useSession } from "../store/session";

const ME = "33333333-3333-4333-8333-333333333333";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";

const mocks = vi.hoisted(() => ({
  api: {
    tasksSticky: vi.fn(),
    stickyPinStates: vi.fn(),
    stickyPin: vi.fn(),
    stickyUnpin: vi.fn(),
    taskAction: vi.fn(),
  },
  toastError: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: mocks.api, config: { kind: "web" } }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: mocks.toastError, success: vi.fn() }) }));

import { BrowserStickies } from "./BrowserStickies";

function task(id: string, title: string): StickyTaskDTO {
  return {
    taskId: id,
    orgId: "00000000-0000-4000-8000-000000000002",
    title,
    description: "",
    senderId: "00000000-0000-4000-8000-000000000001",
    senderUsername: "sender",
    myStatus: "ACKNOWLEDGED",
    actions: actionsFor("ACKNOWLEDGED"),
    statusVersion: 1,
    participants: [],
    assignedAt: "2026-09-19T00:00:00.000Z",
    acknowledgedAt: null,
  } as StickyTaskDTO;
}

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/tasks"]}>
        <BrowserStickies />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ status: "authed" } as never);
  mocks.api.tasksSticky.mockResolvedValue([task(T1, "Write the report")]);
  mocks.api.stickyPinStates.mockResolvedValue({ pinned: [T1], unpinned: [] });
  mocks.api.stickyUnpin.mockResolvedValue({ taskId: T1, state: "UNPINNED", updatedAt: "now" });
});

describe("BrowserStickies follows the shared pin state", () => {
  it("shows the note for a pinned task", async () => {
    mount();
    expect(await screen.findByText("Write the report")).toBeInTheDocument();
  });

  it("does not show a task the server says is UNPINNED — and does so after a reload", async () => {
    mocks.api.stickyPinStates.mockResolvedValue({ pinned: [], unpinned: [T1] });
    mount();
    await waitFor(() => expect(mocks.api.stickyPinStates).toHaveBeenCalled());
    // Let the (not-pinned) render settle, then assert the note never appears.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Write the report")).not.toBeInTheDocument();
  });

  it("clicking Unpin writes it to sticky-svc and the note goes", async () => {
    mount();
    fireEvent.click(await screen.findByTitle(/unpin from the desktop/i));

    await waitFor(() => expect(mocks.api.stickyUnpin).toHaveBeenCalledWith(T1));
    await waitFor(() => expect(screen.queryByText("Write the report")).not.toBeInTheDocument());
  });

  it("brings the note back and says so if the unpin write fails", async () => {
    mocks.api.stickyUnpin.mockRejectedValue(new ApiError(503, "down"));
    mount();
    fireEvent.click(await screen.findByTitle(/unpin from the desktop/i));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(await screen.findByText("Write the report")).toBeInTheDocument();
  });

  it("a realtime unpin from another device removes the note, a re-pin brings it back", async () => {
    const client = mount();
    expect(await screen.findByText("Write the report")).toBeInTheDocument();

    client.setQueryData(qk.stickyPinStates, { [T1]: "UNPINNED" });
    await waitFor(() => expect(screen.queryByText("Write the report")).not.toBeInTheDocument());

    client.setQueryData(qk.stickyPinStates, { [T1]: "PINNED" });
    expect(await screen.findByText("Write the report")).toBeInTheDocument();
  });

  it("is independent per task: unpinning one leaves the other", async () => {
    mocks.api.tasksSticky.mockResolvedValue([task(T1, "Write the report"), task(T2, "Review the deck")]);
    mocks.api.stickyPinStates.mockResolvedValue({ pinned: [T1, T2], unpinned: [] });
    const client = mount();
    await screen.findByText("Write the report");

    client.setQueryData(qk.stickyPinStates, { [T1]: "UNPINNED", [T2]: "PINNED" });

    expect(await screen.findByText("Review the deck")).toBeInTheDocument();
    expect(screen.queryByText("Write the report")).not.toBeInTheDocument();
  });

  it("without sticky-svc configured (null read) vetoes nothing", async () => {
    mocks.api.stickyPinStates.mockResolvedValue(null);
    mount();
    expect(await screen.findByText("Write the report")).toBeInTheDocument();
  });
});
