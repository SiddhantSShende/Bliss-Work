/**
 * Data for the meeting-form tests: an organisation directory, the caller's
 * channels, and a repeating meeting. Plain fixtures — each test file mocks the
 * runtime itself (vi.mock must be hoisted per file) and serves these from it.
 */
import { UserDTO, type CallDTO, type ChannelDTO, type MeetingSeriesDTO } from "@taskboard/shared";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Through the real schema, so a field the server adds later fails HERE, loudly,
// rather than being papered over by a cast.
const user = (n: number, username: string, displayName: string): UserDTO =>
  UserDTO.parse({
    id: id(n),
    orgId: id(999),
    orgName: "Acme",
    username,
    displayName,
    email: `${username}@acme.test`,
    roles: ["member"],
    avatarUrl: null,
    mfaEnrolled: false,
    orgRequireMfaForAdmins: false,
    orgMfaGracePeriodEndsAt: null,
    themePrefs: null,
  });

export const ME = user(1, "me", "Me Myself");
export const ADA = user(2, "ada", "Ada Lovelace");
export const GRACE = user(3, "grace", "Grace Hopper");
export const LINUS = user(4, "linus", "Linus Torvalds");
/** What GET /directory returns: everybody, the caller included. */
export const DIRECTORY: UserDTO[] = [ME, ADA, GRACE, LINUS];

const channel = (n: number, name: string, memberCount: number): ChannelDTO =>
  ({ id: id(n), name, memberCount, lastMessage: null, lastMessageAt: null, lastMessageSender: "" }) as ChannelDTO;

export const GENERAL = channel(101, "general", 12);
export const DESIGN = channel(102, "design", 3);
export const CHANNELS: ChannelDTO[] = [GENERAL, DESIGN];

/** Weekly, every 2 weeks, Tuesday + Thursday, 8 meetings in all. */
export const SERIES: MeetingSeriesDTO = {
  id: id(500),
  status: "ACTIVE",
  recurrence: {
    frequency: "WEEKLY",
    interval: 2,
    weekdays: [1, 3],
    endCondition: "AFTER_OCCURRENCES",
    occurrenceCount: 8,
    timeZone: "Europe/Berlin",
  },
  createdBy: ME.id,
  title: "Design sync",
  media: "video",
  // Tuesday 2026-10-06, 09:30 in Berlin.
  startAt: "2026-10-06T07:30:00.000Z",
  durationMinutes: 60,
  nextStartAt: "2026-11-24T08:30:00.000Z",
  inviteeIds: [ADA.id],
  channelIds: [GENERAL.id],
  occurrenceCount: 6,
};

/** One occurrence of SERIES, as GET /calls/{id} returns it. */
export const OCCURRENCE: CallDTO = {
  id: id(600),
  orgId: id(999),
  kind: "MEETING",
  title: SERIES.title,
  media: "video",
  createdBy: ME.id,
  scheduledAt: "2026-10-06T07:30:00.000Z",
  endsAt: "2026-10-06T08:30:00.000Z",
  status: "SCHEDULED",
  createdAt: "2026-09-28T10:00:00.000Z",
  participants: [],
  activeShares: [],
  channelIds: [GENERAL.id],
  series: { id: SERIES.id, status: "ACTIVE", recurrence: SERIES.recurrence },
};
