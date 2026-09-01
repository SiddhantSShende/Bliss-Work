/**
 * The web counterpart of the desktop sticky note.
 *
 * Two regressions live here, and both are stated positively below:
 *
 *   1. The GC effect ran on a cold mount with the query still unresolved (and
 *      unconditionally while the query was DISABLED), so every stored key
 *      looked stale and the saved note positions were wiped on every page load.
 *   2. Hiding a note was persisted to localStorage, and the task detail view
 *      called into it on open — so reading an allocation retired its note
 *      permanently while the task was still outstanding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StickyTaskDTO } from "@taskboard/shared";

const TASK_ID = "018f0000-0000-7000-8000-0000000000a1";
const POSITION_KEY = "tb.browser-stickies.v1";

const api = {
  tasksSticky: vi.fn(async () => [] as StickyTaskDTO[]),
  taskAction: vi.fn(async () => {}),
};
let config: Record<string, unknown> = {};
let authed = true;

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: unknown) => unknown) => sel({ status: authed ? "authed" : "anon" }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { BrowserStickies } from "./BrowserStickies";

function task(over: Partial<StickyTaskDTO> = {}): StickyTaskDTO {
  return {
    taskId: TASK_ID,
    orgId: "org-1",
    title: "Ship the thing",
    description: "",
    senderId: "u-someone",
    senderUsername: "someone",
    myStatus: "SENT",
    actions: ["ACKNOWLEDGE", "IGNORE"],
    statusVersion: 0,
    assignedAt: "2026-08-01T09:00:00.000Z",
    reviewRating: null,
    ...over,
  } as StickyTaskDTO;
}

function renderStickies() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/mail"]}>
        <BrowserStickies />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

/** A saved note position for a task the server has NOT told us about yet. */
const savedPositions = () =>
  JSON.stringify({ [TASK_ID]: { collapsed: false, x: 120, y: 240 } });

beforeEach(() => {
  window.localStorage.clear();
  config = {};
  authed = true;
  api.tasksSticky.mockReset();
  api.tasksSticky.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("saved note positions survive a page load", () => {
  it("does not wipe them before the task list has resolved", async () => {
    window.localStorage.setItem(POSITION_KEY, savedPositions());
    // A request that never settles: the component is mounted, the query is
    // in flight, and `tasks` is still the default []. Nothing may be retired
    // on the strength of a list the server has not actually produced.
    api.tasksSticky.mockImplementation(() => new Promise<StickyTaskDTO[]>(() => {}));

    renderStickies();
    await new Promise((r) => setTimeout(r, 50));

    expect(JSON.parse(window.localStorage.getItem(POSITION_KEY)!)).toHaveProperty(TASK_ID);
  });

  it("does not wipe them when the query is disabled (Electron, where real windows are used)", async () => {
    window.localStorage.setItem(POSITION_KEY, savedPositions());
    config = { pinTask: vi.fn() }; // presence of pinTask IS the Electron check

    renderStickies();
    await new Promise((r) => setTimeout(r, 50));

    expect(JSON.parse(window.localStorage.getItem(POSITION_KEY)!)).toHaveProperty(TASK_ID);
    expect(api.tasksSticky).not.toHaveBeenCalled();
  });

  it("does not wipe them before sign-in", async () => {
    window.localStorage.setItem(POSITION_KEY, savedPositions());
    authed = false;

    renderStickies();
    await new Promise((r) => setTimeout(r, 50));

    expect(JSON.parse(window.localStorage.getItem(POSITION_KEY)!)).toHaveProperty(TASK_ID);
  });

  it("DOES retire them once a live list says the task is gone", async () => {
    window.localStorage.setItem(POSITION_KEY, savedPositions());
    api.tasksSticky.mockResolvedValue([]); // a real, successful, empty answer

    renderStickies();
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(POSITION_KEY)!)).not.toHaveProperty(TASK_ID),
    );
  });
});

describe("an assigned task floats on its own", () => {
  it("shows a note for a SENT task", async () => {
    api.tasksSticky.mockResolvedValue([task()]);
    renderStickies();
    expect(await screen.findByText("Ship the thing")).toBeInTheDocument();
  });

  it("keeps showing it once acknowledged", async () => {
    api.tasksSticky.mockResolvedValue([task({ myStatus: "ACKNOWLEDGED", actions: ["COMPLETE"] })]);
    renderStickies();
    expect(await screen.findByText("Ship the thing")).toBeInTheDocument();
  });

  it("does not show terminal tasks", async () => {
    api.tasksSticky.mockResolvedValue([task({ myStatus: "COMPLETED", actions: [] })]);
    renderStickies();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Ship the thing")).not.toBeInTheDocument();
  });
});

describe("hiding a note lasts for this session only", () => {
  it("takes it off screen when dismissed", async () => {
    api.tasksSticky.mockResolvedValue([task()]);
    const user = userEvent.setup();
    renderStickies();
    await screen.findByText("Ship the thing");

    await user.click(screen.getByLabelText("Dismiss sticky note"));
    await waitFor(() => expect(screen.queryByText("Ship the thing")).not.toBeInTheDocument());
  });

  it("persists NOTHING about the dismissal", async () => {
    api.tasksSticky.mockResolvedValue([task()]);
    const user = userEvent.setup();
    renderStickies();
    await screen.findByText("Ship the thing");

    await user.click(screen.getByLabelText("Dismiss sticky note"));
    await waitFor(() => expect(screen.queryByText("Ship the thing")).not.toBeInTheDocument());

    // The old key. Nothing may write it: that is what made a hide permanent.
    expect(window.localStorage.getItem("tb.browser-stickies.unpinned.v1")).toBeNull();
  });

  it("COMES BACK on a reload, because the task is still outstanding", async () => {
    api.tasksSticky.mockResolvedValue([task()]);
    const user = userEvent.setup();
    const first = renderStickies();
    await screen.findByText("Ship the thing");
    await user.click(screen.getByLabelText("Dismiss sticky note"));
    await waitFor(() => expect(screen.queryByText("Ship the thing")).not.toBeInTheDocument());
    first.unmount();

    renderStickies();
    expect(await screen.findByText("Ship the thing")).toBeInTheDocument();
  });
});
