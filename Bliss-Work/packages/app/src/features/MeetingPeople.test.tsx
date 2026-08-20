/**
 * The invited-members popup on a meeting card.
 *
 * The card's chips are counts; this sheet is the only place the app answers
 * "who are these people" for a meeting you are not in yet. The three things
 * that makes it useful are pinned here because none of them is visible from
 * the counts: the email address (the roster DTO does not carry one — it is
 * joined on from the directory), the search box that appears once the list is
 * too long to read, and the total, which stops agreeing with the tab badge the
 * moment a search narrows the list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO, CallParticipantDTO } from "@taskboard/shared";

const ORG = "018f0000-0000-7000-8000-00000000000f";
const ME = "018f0000-0000-7000-8000-0000000000a1";

const h = vi.hoisted(() => ({
  api: { directory: vi.fn(), graphql: vi.fn() },
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: h.api, config: { kind: "web" } }),
}));
vi.mock("../store/session", () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({ user: { id: ME, orgId: ORG, orgName: "Acme" } }),
}));

import { MeetingPeopleSheet } from "./MeetingPeople";

const id = (n: number) => `018f0000-0000-7000-8000-0000000000${String(n).padStart(2, "b")}`;

/** A directory row, which is where the email on each line comes from. */
const person = (userId: string, name: string) => ({
  id: userId,
  orgId: ORG,
  orgName: "Acme",
  username: name.toLowerCase().replace(/\s+/g, "."),
  displayName: name,
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@acme.test`,
  roles: ["member"],
  emailVerified: true,
  plan: "free",
});

const participant = (userId: string, over: Partial<CallParticipantDTO> = {}): CallParticipantDTO => ({
  userId,
  orgId: ORG,
  role: "PARTICIPANT",
  username: "",
  joinedAt: null,
  leftAt: null,
  waitingSince: null,
  external: false,
  ...over,
});

const call = (participants: CallParticipantDTO[]): CallDTO => ({
  id: id(1),
  orgId: ORG,
  kind: "MEETING",
  channelId: null,
  title: "Quarterly review",
  media: "video",
  createdBy: ME,
  scheduledAt: new Date(0).toISOString(),
  endsAt: null,
  startedAt: null,
  startedBy: null,
  endedAt: null,
  status: "SCHEDULED",
  createdAt: new Date(0).toISOString(),
  participants,
  activeShares: [],
  recordingStatus: null,
});

/** `count` invitees, the first of whom is the signed-in user. */
function roster(count: number) {
  const names = ["Ada Lovelace", "Bo Carter", "Cleo Nkemdi", "Dev Patel", "Eve Moreau",
    "Femi Adeyemi", "Gus Lindqvist", "Hana Sato", "Ivan Petrov", "Jane Okafor"];
  const people = names.slice(0, count).map((name, i) => person(i === 0 ? ME : id(i + 2), name));
  h.api.directory.mockResolvedValue(people);
  return people.map((p, i) =>
    participant(p.id, { username: p.username, role: i === 0 ? "HOST" : "PARTICIPANT" }),
  );
}

function open(participants: CallParticipantDTO[], onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MeetingPeopleSheet call={call(participants)} open initialTab="invited" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, user: userEvent.setup() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MeetingPeopleSheet", () => {
  it("lists every invited member with their name and email address", async () => {
    open(roster(3));

    expect(await screen.findByText("bo.carter@acme.test")).toBeInTheDocument();
    expect(screen.getByText("Bo Carter")).toBeInTheDocument();
    expect(screen.getByText("cleo.nkemdi@acme.test")).toBeInTheDocument();
    // The signed-in person is marked rather than left to be recognised.
    expect(screen.getByText("Ada Lovelace").parentElement).toHaveTextContent("(you)");
  });

  it("states the total, so the number is on screen and not only on the tab", async () => {
    open(roster(3));
    expect(await screen.findByText("3 members invited")).toBeInTheDocument();
  });

  it("says 'member' rather than 'members' for a roster of one", async () => {
    open(roster(1));
    expect(await screen.findByText("1 member invited")).toBeInTheDocument();
  });

  it("offers no search box for a roster short enough to read", async () => {
    open(roster(3));
    await screen.findByText("Bo Carter");
    expect(screen.queryByLabelText("Search members")).not.toBeInTheDocument();
  });

  it("filters a long roster by name and reports how many of the total are shown", async () => {
    const { user } = open(roster(10));
    await screen.findByText("Bo Carter");

    await user.type(screen.getByLabelText("Search members"), "hana");

    expect(screen.getByText("Hana Sato")).toBeInTheDocument();
    expect(screen.queryByText("Bo Carter")).not.toBeInTheDocument();
    // The total stays visible next to the match count — filtering must not make
    // a ten-person meeting look like a one-person meeting.
    expect(screen.getByText("1 of 10 shown")).toBeInTheDocument();
  });

  it("filters by email address, not just by name", async () => {
    const { user } = open(roster(10));
    await screen.findByText("Bo Carter");

    await user.type(screen.getByLabelText("Search members"), "gus.lindqvist@acme");

    expect(screen.getByText("Gus Lindqvist")).toBeInTheDocument();
    expect(screen.getByText("1 of 10 shown")).toBeInTheDocument();
  });

  it("says so when a search matches nobody, instead of showing an empty meeting", async () => {
    const { user } = open(roster(10));
    await screen.findByText("Bo Carter");

    await user.type(screen.getByLabelText("Search members"), "nobody");

    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText("Nobody is invited")).not.toBeInTheDocument();
  });

  it("closes on the X", async () => {
    const { onClose, user } = open(roster(3));
    await screen.findByText("Bo Carter");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
