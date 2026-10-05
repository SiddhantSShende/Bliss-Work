/**
 * The People/Members + Channels group on its own, in the meeting form's wording
 * and white-card tone (the task form's use of it is covered by
 * CreateTaskDialog.test.tsx). Real pickers and queries; only the api is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, CHANNELS, DIRECTORY, GENERAL, GRACE, ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({ api: { directory: vi.fn(), channels: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { MeetingAudienceFields } from "./MeetingAudienceFields";

let latest = { invitees: new Set<string>(), channels: new Set<string>() };

function Harness() {
  const [invitees, setInvitees] = useState(new Set<string>());
  const [channels, setChannels] = useState(new Set<string>());
  latest = { invitees, channels };
  const flip = (s: Set<string>, id: string) => {
    const n = new Set(s);
    if (!n.delete(id)) n.add(id);
    return n;
  };
  return (
    <MeetingAudienceFields
      invitees={invitees}
      onToggleInvitee={(id) => setInvitees((s) => flip(s, id))}
      channels={channels}
      onToggleChannel={(id) => setChannels((s) => flip(s, id))}
    />
  );
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>,
  );
});

const members = () => screen.getByRole("group", { name: "Members" });
const channels = () => screen.getByRole("group", { name: "Channels" });

describe("MeetingAudienceFields", () => {
  it("shows a live count on each group, and both groups stay on screen while either picker is open", async () => {
    const user = userEvent.setup();
    expect(within(members()).getByText("(0)")).toBeInTheDocument();
    expect(within(channels()).getByText("(0)")).toBeInTheDocument();

    await user.click(within(members()).getByRole("button", { name: "Add members" }));
    await user.click(await within(members()).findByRole("button", { name: /Ada Lovelace/ }));
    await user.click(within(members()).getByRole("button", { name: /Grace Hopper/ }));
    await user.click(within(channels()).getByRole("button", { name: "Add channels" }));
    await user.click(await within(channels()).findByRole("button", { name: /general/ }));

    expect(within(members()).getByText("(2)")).toBeInTheDocument();
    expect(within(channels()).getByText("(1)")).toBeInTheDocument();
    expect(within(members()).getByRole("list")).toHaveTextContent("Ada Lovelace");
    expect(within(channels()).getByRole("list")).toHaveTextContent("general");
    expect([...latest.invitees].sort()).toEqual([ADA.id, GRACE.id].sort());
    expect([...latest.channels]).toEqual([GENERAL.id]);

    // The picker for one group does not hide the other's.
    expect(within(members()).getByRole("textbox", { name: "Search your organisation" })).toBeInTheDocument();
    expect(within(channels()).getByRole("textbox", { name: "Search your channels" })).toBeInTheDocument();
  });

  it("does not offer the caller, and a removed chip un-checks its row and drops the count", async () => {
    const user = userEvent.setup();
    await user.click(within(members()).getByRole("button", { name: "Add members" }));
    await within(members()).findByRole("button", { name: /Ada Lovelace/ });
    expect(within(members()).queryByRole("button", { name: /Me Myself/ })).not.toBeInTheDocument();

    await user.click(within(members()).getByRole("button", { name: /Ada Lovelace/ }));
    await user.click(within(members()).getByRole("button", { name: "Remove Ada Lovelace" }));

    expect(within(members()).getByText("(0)")).toBeInTheDocument();
    expect(within(members()).getByRole("button", { name: /Ada Lovelace/, pressed: false })).toBeInTheDocument();
    expect(latest.invitees.size).toBe(0);
  });
});
