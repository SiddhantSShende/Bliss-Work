/**
 * The New Meeting form is a white card in light mode and is painted with the app's
 * surface tokens (the New Task modal's palette) in dark mode. jsdom has no styles, so
 * this pins the classes: in dark mode nothing inside the dialog may carry the
 * hardcoded light palette, and in light mode the white card is still there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { CHANNELS, DIRECTORY, ME } from "../test/meetingFixtures";
import { channelsPageOf, directoryPageOf } from "../test/meetingPaging";

const h = vi.hoisted(() => ({
  isDark: true,
  api: { scheduleMeeting: vi.fn(), createCallInvite: vi.fn(), directoryPage: vi.fn(), channelsPage: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: { webBaseUrl: "https://app.test" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@taskboard/ui", async (orig) => ({
  ...(await orig<typeof import("@taskboard/ui")>()),
  useTheme: () => ({ isDark: h.isDark }),
}));

import { NewMeetingDialog } from "./NewMeetingDialog";

/** Every class token under (and including) `root`. */
function classTokens(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((el) =>
    (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
  );
}

async function openDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewMeetingDialog onClose={vi.fn()} onStarted={vi.fn()} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  // Weekly repeat, the People list loaded with a row picked, and the Channels tab's list
  // too, so the optional controls and every list state are painted.
  await user.selectOptions(screen.getByLabelText("Repeat"), "WEEKLY");
  await user.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
  await user.click(screen.getByRole("tab", { name: /^Channels/ }));
  await screen.findByRole("button", { name: /general/ });
  return screen.getByRole("dialog", { name: "New Meeting" });
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.directoryPage.mockReset().mockImplementation(directoryPageOf(DIRECTORY));
  h.api.channelsPage.mockReset().mockImplementation(channelsPageOf(CHANNELS));
});

describe("New Meeting dialog palette", () => {
  it("dark mode: no hardcoded white/gray anywhere in the dialog", async () => {
    h.isDark = true;
    const dialog = await openDialog();
    const light = classTokens(dialog).filter((c) => /(^|:)(bg-white|bg-gray-|border-gray-|text-gray-|hover:bg-gray-|placeholder:text-gray-)/.test(c));

    expect(light).toEqual([]);
    expect(dialog.className).toContain("bg-surface");
  });

  it("light mode: still the white card", async () => {
    h.isDark = false;
    const dialog = await openDialog();

    expect(dialog.className).toContain("bg-white");
    expect(dialog.className).not.toContain("bg-surface");
    expect(classTokens(dialog)).toContain("border-gray-300");
  });
});
