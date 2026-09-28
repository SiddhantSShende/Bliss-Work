/**
 * What a meeting's detail page and list row say about repeating and channels —
 * and, as importantly, that they say nothing new about a meeting that does neither.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { CallDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { CHANNELS, DESIGN, GENERAL, ME, OCCURRENCE } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: { call: vi.fn(), channels: vi.fn(), meetingSeries: vi.fn(), directory: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), restore: vi.fn(), call: null }),
}));
vi.mock("../lib/userLabel", () => ({
  useUserLabels: () => ({ nameOf: (id: string) => `user-${id.slice(-3)}`, avatarUrlOf: () => null }),
}));
vi.mock("../lib/callWindow", () => ({ openCallTab: () => false }));
// Not what is under test.
vi.mock("../features/MeetingInviteLink", () => ({ MeetingInviteLink: () => null }));
vi.mock("../features/MeetingTranscript", () => ({
  MeetingChatPanel: () => null,
  MeetingNotesPanel: () => null,
}));

import { MeetingDetail } from "./MeetingDetail";
import { MeetingRow } from "../features/MeetingRow";

function renderDetail(call: CallDTO) {
  h.api.call.mockResolvedValue(call);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/meetings/${call.id}`]}>
        <Routes>
          <Route path="/app/meetings/:callId" element={<MeetingDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  h.api.directory.mockReset().mockResolvedValue([]);
  h.api.meetingSeries.mockReset();
});

const fact = (label: string) => screen.queryByText(label, { selector: "dt" })?.parentElement ?? null;

describe("a repeating meeting's page", () => {
  it("says how it repeats", async () => {
    renderDetail(OCCURRENCE);
    await screen.findByRole("heading", { name: "Design sync" });
    expect(fact("Repeats")).toHaveTextContent("Repeats every 2 weeks on Tue, Thu, 8 meetings in total");
  });

  it("names the channels it was addressed to", async () => {
    renderDetail({ ...OCCURRENCE, channelIds: [GENERAL.id, DESIGN.id] });
    await screen.findByRole("heading", { name: "Design sync" });
    await vi.waitFor(() => expect(fact("Channels")).toHaveTextContent("#general, #design"));
  });

  // A channel the viewer is not in is not in their list, so it has no name to show.
  it("counts a channel it cannot name, rather than pretending to know it", async () => {
    renderDetail({ ...OCCURRENCE, channelIds: [GENERAL.id, "00000000-0000-4000-8000-000000000909"] });
    await screen.findByRole("heading", { name: "Design sync" });
    await vi.waitFor(() => expect(fact("Channels")).toHaveTextContent("#general, 1 channel"));
  });

  it("offers the organiser Edit and Cancel", async () => {
    renderDetail(OCCURRENCE);
    expect(await screen.findByRole("button", { name: "Edit series" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel series" })).toBeInTheDocument();
  });

  it("offers nobody else either", async () => {
    renderDetail({ ...OCCURRENCE, createdBy: "00000000-0000-4000-8000-000000000099" });
    await screen.findByRole("heading", { name: "Design sync" });
    expect(screen.queryByRole("button", { name: "Edit series" })).not.toBeInTheDocument();
  });
});

describe("a meeting that neither repeats nor has channels", () => {
  it("shows exactly what it always did", async () => {
    renderDetail({ ...OCCURRENCE, series: null, channelIds: [], title: "One-off" });
    await screen.findByRole("heading", { name: "One-off" });
    expect(fact("Repeats")).toBeNull();
    expect(fact("Channels")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit series" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel series" })).not.toBeInTheDocument();
  });

  // A meeting from before this feature carries neither field at all.
  it("copes with the fields simply being absent, as on every older meeting", async () => {
    const legacy = { ...OCCURRENCE, title: "Old" } as Partial<CallDTO>;
    delete legacy.series;
    delete legacy.channelIds;
    renderDetail({ ...(legacy as CallDTO), channelIds: [] });
    await screen.findByRole("heading", { name: "Old" });
    expect(fact("Repeats")).toBeNull();
  });
});

describe("the meeting list row", () => {
  const renderRow = (call: CallDTO) =>
    render(
      <MemoryRouter>
        <ul>
          <MeetingRow call={call} search="" name="Design sync" organiser="Me" organiserAvatar={null} />
        </ul>
      </MemoryRouter>,
    );

  it("marks an occurrence of a repeating meeting", () => {
    renderRow(OCCURRENCE);
    expect(within(screen.getByRole("listitem")).getByText("Repeating meeting")).toBeInTheDocument();
  });

  it("does not mark a one-off", () => {
    renderRow({ ...OCCURRENCE, series: null });
    expect(screen.queryByText("Repeating meeting")).not.toBeInTheDocument();
  });
});
