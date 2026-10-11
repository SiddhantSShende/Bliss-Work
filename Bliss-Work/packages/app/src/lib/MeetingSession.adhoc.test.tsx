/**
 * An ad-hoc call held by the meeting session is not a meeting: no "you were in a
 * meeting — rejoin?" offer is remembered for it, and minimising its /call/:id
 * tab does not drop the user into the Meetings area. A real meeting does both,
 * exactly as before.
 */
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallDTO } from "@taskboard/shared";
import { OCCURRENCE } from "../test/meetingFixtures";
import { MeetingSessionProvider, useMeetingSession } from "./MeetingSession";

vi.mock("./runtime", () => ({ useRuntime: () => ({ config: {} }) }));

const RESUME_KEY = "tb.meeting-resume.v1";

const MEETING: CallDTO = OCCURRENCE;
const ADHOC: CallDTO = {
  ...OCCURRENCE,
  id: "00000000-0000-4000-8000-000000000700",
  kind: "DIRECT",
  title: "",
  scheduledAt: undefined,
  endsAt: undefined,
  status: "LIVE",
};

let session: ReturnType<typeof useMeetingSession>;
function Probe() {
  session = useMeetingSession();
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function mount(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <MeetingSessionProvider>
        <Probe />
      </MeetingSessionProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => window.sessionStorage.clear());

describe("remembering a call across a reload", () => {
  it("does not for an ad-hoc call", () => {
    mount("/app/chats");
    act(() => session.enter(ADHOC));

    expect(session.call?.id).toBe(ADHOC.id);
    expect(window.sessionStorage.getItem(RESUME_KEY)).toBeNull();
  });

  it("does for a meeting", () => {
    mount("/app/chats");
    act(() => session.enter(MEETING));

    expect(window.sessionStorage.getItem(RESUME_KEY)).toBe(MEETING.id);
  });

  it("does for a scheduled DIRECT call, which is not ad-hoc", () => {
    mount("/app/chats");
    const scheduled = { ...ADHOC, scheduledAt: "2031-03-14T09:30:00.000Z" };
    act(() => session.enter(scheduled));

    expect(window.sessionStorage.getItem(RESUME_KEY)).toBe(scheduled.id);
  });
});

describe("minimising the call's own tab", () => {
  it("goes to the app, not to Meetings, for an ad-hoc call", () => {
    mount("/call/abc");
    act(() => session.enter(ADHOC));
    act(() => session.minimize());

    expect(screen.getByTestId("path")).toHaveTextContent(/^\/app$/);
    expect(session.minimized).toBe(true);
  });

  it("goes to Meetings for a meeting", () => {
    mount("/call/abc");
    act(() => session.enter(MEETING));
    act(() => session.minimize());

    expect(screen.getByTestId("path")).toHaveTextContent(/^\/app\/meetings$/);
  });
});
