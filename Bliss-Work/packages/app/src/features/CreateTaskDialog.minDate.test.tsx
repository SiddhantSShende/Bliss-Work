/**
 * The Start date's `min` is the viewer's local "today". It used to be the UTC
 * date, so in the evening west of UTC it was already tomorrow and today could
 * not be picked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { CHANNELS, DIRECTORY, ME } from "../test/meetingFixtures";
import { pagedChannels, pagedDirectory } from "../test/pagedPickerApi";

const h = vi.hoisted(() => ({
  api: { createTask: vi.fn(), directoryPage: vi.fn(), channelsPage: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { CreateTaskDialog } from "./CreateTaskDialog";

const realTZ = process.env.TZ;

beforeEach(() => {
  process.env.TZ = "America/Los_Angeles"; // UTC-7 in September
  vi.useFakeTimers({ toFake: ["Date"] });
  // 22:00 on 15 Sep in Los Angeles is already 05:00 on 16 Sep UTC.
  vi.setSystemTime(new Date("2026-09-16T05:00:00Z"));
  useSession.setState({ user: ME });
  h.api.directoryPage.mockReset().mockImplementation(pagedDirectory(DIRECTORY));
  h.api.channelsPage.mockReset().mockImplementation(pagedChannels(CHANNELS));
});
afterEach(() => {
  vi.useRealTimers();
  if (realTZ === undefined) delete process.env.TZ;
  else process.env.TZ = realTZ;
});

describe("CreateTaskDialog start date minimum", () => {
  it("is the local date, not the UTC date, in the evening west of UTC", async () => {
    expect(new Date().getDate()).toBe(15); // the TZ switch took effect
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateTaskDialog open onClose={() => {}} />
      </QueryClientProvider>,
    );
    await userEvent.setup({ advanceTimers: () => {} }).click(screen.getByRole("radio", { name: /Schedule for later/ }));

    expect(screen.getByLabelText("Start date").getAttribute("min")).toBe("2026-09-15");
  });
});
