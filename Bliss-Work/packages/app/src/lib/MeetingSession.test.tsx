/**
 * What happens to a meeting when the user goes somewhere else.
 *
 * The room is a full-screen overlay above every route, so a navigation that
 * happens while it is up is invisible: the page the user asked for arrives
 * BEHIND a meeting they are no longer watching, and the only way to see it was
 * to find the Minimise button. Every route into the app during a meeting — the
 * "call has started" toast's Join action, a sticky note, the back button — hit
 * that, and none of them are reachable from a test of the room itself.
 *
 * So these are about the session that owns "which meeting, and is it
 * full-screen", plus the one invariant the whole design rests on: the room is
 * MOUNTED once and never unmounted, because unmounting it is what hangs up the
 * call.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";
import { MeetingSessionProvider, useMeetingSession } from "./MeetingSession";
import { MeetingHost } from "../features/MeetingHost";

/**
 * The room is the LiveKit stack, which has no business in a routing test. What
 * DOES matter here is how often it is mounted, so the stand-in counts that and
 * nothing else — an unmount is a dropped call.
 */
const room = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock("../features/CallRoomLazy", async () => {
  const { useEffect } = await import("react");
  return {
    CallRoom: ({ call }: { call: CallDTO; onClose: () => void }) => {
      useEffect(() => {
        room.mounts += 1;
        return () => {
          room.unmounts += 1;
        };
      }, []);
      return <div data-testid="room">{call.id}</div>;
    },
  };
});

// MeetingHost's rejoin offer reads the API. Nothing here is about that offer —
// it is never made, because no tab was in a meeting before these tests.
//
// `config` is mutable per-test (default web-shaped: no openMeetingWindow) so
// the Electron-branch describe block below can swap in an
// openMeetingWindow spy without a second mock factory.
const rt = vi.hoisted(() => ({
  config: {} as { openMeetingWindow?: (callId: string) => void },
}));
vi.mock("./runtime", () => ({
  useRuntime: () => ({ api: { call: vi.fn() }, config: rt.config }),
}));

const CALL: CallDTO = {
  id: "33333333-3333-3333-3333-333333333333",
  orgId: "11111111-1111-1111-1111-111111111111",
  kind: "MEETING",
  title: "Sprint review",
  media: "video",
  createdBy: "22222222-2222-2222-2222-222222222222",
  status: "LIVE",
  createdAt: "2026-08-20T09:00:00.000Z",
  participants: [],
  activeShares: [],
};

/** The session's state and controls, plus a way to move the router. */
function Harness() {
  const { call, minimized, enter, exit, minimize, restore } = useMeetingSession();
  const location = useLocation();
  const nav = useNavigate();
  return (
    <div>
      <span data-testid="where">{`${location.pathname}${location.search}`}</span>
      <span data-testid="state">
        {call ? (minimized ? "minimized" : "fullscreen") : "no-meeting"}
      </span>
      <button onClick={() => enter(CALL)}>enter</button>
      <button onClick={() => exit()}>exit</button>
      <button onClick={() => minimize()}>minimize</button>
      <button onClick={() => restore()}>restore</button>
      <button onClick={() => nav("/app/tasks")}>go tasks</button>
      <button onClick={() => nav("/app/mail")}>go mail</button>
      <button onClick={() => nav({ search: "?thread=t1" })}>open thread here</button>
    </div>
  );
}

function mount(at: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[at]}>
        <MeetingSessionProvider>
          <Harness />
          {/* The real host: it is what keeps the room mounted across all of
              this, and hiding it while minimised is CallRoom's own business. */}
          <MeetingHost />
        </MeetingSessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const state = () => screen.getByTestId("state").textContent;
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  room.mounts = 0;
  room.unmounts = 0;
  rt.config = {};
  window.sessionStorage.clear();
});

describe("MeetingSession — leaving the room minimises it", () => {
  it("minimises when the user navigates away from the view the meeting took over", async () => {
    const user = mount("/app/meetings");

    await user.click(screen.getByText("enter"));
    expect(state()).toBe("fullscreen");

    await user.click(screen.getByText("go tasks"));
    expect(state()).toBe("minimized");
    expect(where()).toBe("/app/tasks");
  });

  it("stays full-screen when the view it is on only changes its query string", async () => {
    const user = mount("/app/channels/c1");

    await user.click(screen.getByText("enter"));
    await user.click(screen.getByText("open thread here"));

    expect(where()).toBe("/app/channels/c1?thread=t1");
    expect(state()).toBe("fullscreen");
  });

  it("restores where the user asked for it, and does not put itself away again", async () => {
    const user = mount("/app/meetings");
    await user.click(screen.getByText("enter"));
    await user.click(screen.getByText("go tasks"));
    expect(state()).toBe("minimized");

    await user.click(screen.getByText("restore"));
    expect(state()).toBe("fullscreen");

    // Re-anchored to /app/tasks: staying there keeps the room up…
    await user.click(screen.getByText("open thread here"));
    expect(state()).toBe("fullscreen");
    // …and leaving THAT view puts it away again.
    await user.click(screen.getByText("go mail"));
    expect(state()).toBe("minimized");
  });

  it("never unmounts the room — not to minimise, navigate, restore or minimise again", async () => {
    const user = mount("/app/meetings");

    await user.click(screen.getByText("enter"));
    expect(screen.getByTestId("room")).toBeInTheDocument();

    await user.click(screen.getByText("go tasks"));
    await user.click(screen.getByText("restore"));
    await user.click(screen.getByText("go mail"));
    await user.click(screen.getByText("restore"));

    expect(screen.getByTestId("room")).toBeInTheDocument();
    expect(room.mounts).toBe(1);
    expect(room.unmounts).toBe(0);
  });

  it("leaves the meeting alone once it is over", async () => {
    const user = mount("/app/meetings");
    await user.click(screen.getByText("enter"));
    await user.click(screen.getByText("exit"));

    expect(state()).toBe("no-meeting");
    expect(screen.queryByTestId("room")).not.toBeInTheDocument();

    await user.click(screen.getByText("go tasks"));
    expect(state()).toBe("no-meeting");
  });
});

describe("MeetingSession — a meeting in its own tab", () => {
  it("still takes the Minimise button into the app, since /call/:id has nothing behind it", async () => {
    const user = mount("/call/33333333-3333-3333-3333-333333333333");
    await user.click(screen.getByText("enter"));
    expect(state()).toBe("fullscreen");

    await user.click(screen.getByText("minimize"));

    expect(state()).toBe("minimized");
    expect(where()).toBe("/app/meetings");
  });

  it("does not move the user a second time when they navigated out of it themselves", async () => {
    const user = mount("/call/33333333-3333-3333-3333-333333333333");
    await user.click(screen.getByText("enter"));

    await user.click(screen.getByText("go tasks"));

    expect(state()).toBe("minimized");
    // Where they asked to go, NOT the /app/meetings the button would have used.
    expect(where()).toBe("/app/tasks");
  });
});

describe("MeetingSession — Electron's separate meeting window", () => {
  it("opens the meeting in its own window instead of rendering CallRoom here, when openMeetingWindow is present", async () => {
    const openMeetingWindow = vi.fn();
    rt.config = { openMeetingWindow };
    const user = mount("/app/meetings");

    await user.click(screen.getByText("enter"));

    expect(openMeetingWindow).toHaveBeenCalledWith(CALL.id);
    // No overlay in THIS window: no local `call` state, so nothing to
    // minimise/restore/exit, and the room stand-in never mounts here.
    expect(state()).toBe("no-meeting");
    expect(screen.queryByTestId("room")).not.toBeInTheDocument();
    expect(room.mounts).toBe(0);
  });
});
