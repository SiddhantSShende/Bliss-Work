import { describe, expect, it } from "vitest";
import type { CallDTO } from "@taskboard/shared";
import {
  bucketFor,
  bucketOf,
  durationLabel,
  durationMsOf,
  isMeetingDetailPath,
  joinNames,
  meetingDisplayName,
  meetingSearch,
  statusLabel,
} from "./meetingView";

const HOUR = 3_600_000;

function call(over: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    orgId: "22222222-2222-2222-2222-222222222222",
    kind: "MEETING",
    title: "",
    media: "video",
    createdBy: "u-host",
    status: "ENDED",
    createdAt: "2026-08-01T09:00:00.000Z",
    participants: [],
    activeShares: [],
    ...over,
  } as CallDTO;
}

function person(userId: string, joined = true) {
  return {
    userId,
    orgId: "22222222-2222-2222-2222-222222222222",
    role: "PARTICIPANT" as const,
    username: userId,
    joinedAt: joined ? "2026-08-01T09:00:00.000Z" : null,
    leftAt: null,
    waitingSince: null,
    external: false,
  };
}

/** Names come from the directory, so the tests supply the lookup the UI does. */
const nameOf = (id: string) => ({ "u-m": "Mayank", "u-s": "Siddhant", "u-a": "Ada", "u-b": "Bo", "u-c": "Cy", "u-me": "Me" })[id] ?? id;

describe("meetingDisplayName", () => {
  it("uses the meeting's own title when it has one", () => {
    expect(meetingDisplayName(call({ title: "Sprint review" }), nameOf)).toBe("Sprint review");
  });

  it("ignores a title that is only whitespace — that is not a name", () => {
    expect(meetingDisplayName(call({ title: "   " }), nameOf, null)).toBe("Untitled meeting");
  });

  it("names an untitled meeting after the people who JOINED it", () => {
    const c = call({
      participants: [person("u-m"), person("u-s"), person("u-a"), person("u-b"), person("u-c"), person("u-me")],
    });
    // Five others besides the viewer: two named, the rest counted — the shape
    // the brief asks for.
    expect(meetingDisplayName(c, nameOf, "u-me")).toBe("Mayank, Siddhant & 3 others");
  });

  it("leaves the VIEWER out — you were in your own meetings", () => {
    const c = call({ participants: [person("u-me"), person("u-a")] });
    expect(meetingDisplayName(c, nameOf, "u-me")).toBe("Ada");
  });

  it("falls back to the viewer's own name when they were the only one there", () => {
    const c = call({ participants: [person("u-me")] });
    expect(meetingDisplayName(c, nameOf, "u-me")).toBe("Me");
  });

  it("uses the INVITED roster before anybody has joined — an upcoming meeting has no attendance yet", () => {
    const c = call({
      status: "SCHEDULED",
      participants: [person("u-a", false), person("u-b", false)],
    });
    expect(meetingDisplayName(c, nameOf, "u-me")).toBe("Ada & Bo");
  });

  it("prefers who TURNED UP over who was invited, once anybody has", () => {
    const c = call({ participants: [person("u-a", true), person("u-b", false), person("u-c", false)] });
    expect(meetingDisplayName(c, nameOf, "u-me")).toBe("Ada");
  });
});

describe("joinNames", () => {
  it("spells out up to three names rather than saying '& 1 other'", () => {
    expect(joinNames(["Ada"])).toBe("Ada");
    expect(joinNames(["Ada", "Bo"])).toBe("Ada & Bo");
    expect(joinNames(["Ada", "Bo", "Cy"])).toBe("Ada, Bo & Cy");
  });

  it("counts the rest from four up", () => {
    expect(joinNames(["Ada", "Bo", "Cy", "Di"])).toBe("Ada, Bo & 2 others");
  });

  it("has something to say about a meeting with nobody in it", () => {
    expect(joinNames([])).toBe("Untitled meeting");
  });
});

describe("durationMsOf", () => {
  it("is start-to-end for a finished meeting", () => {
    const c = call({
      startedAt: "2026-08-01T09:00:00.000Z",
      endedAt: "2026-08-01T10:30:00.000Z",
    });
    expect(durationMsOf(c)).toBe(1.5 * HOUR);
  });

  it("is start-to-NOW for a live one — a reading, not a total", () => {
    const startedAt = new Date(Date.now() - HOUR).toISOString();
    expect(durationMsOf(call({ status: "LIVE", startedAt }))).toBeGreaterThanOrEqual(HOUR - 5_000);
  });

  it("is the PLANNED length for a scheduled meeting that named one", () => {
    const c = call({
      status: "SCHEDULED",
      scheduledAt: "2026-09-01T09:00:00.000Z",
      endsAt: "2026-09-01T09:45:00.000Z",
    });
    expect(durationMsOf(c)).toBe(45 * 60_000);
  });

  it("invents nothing for a meeting that named no duration and never ran", () => {
    expect(durationMsOf(call({ status: "SCHEDULED", scheduledAt: "2026-09-01T09:00:00.000Z" }))).toBeNull();
  });
});

describe("durationLabel", () => {
  it("reads the way a person would say it", () => {
    expect(durationLabel(45 * 60_000)).toBe("45m");
    expect(durationLabel(HOUR)).toBe("1h");
    expect(durationLabel(HOUR + 20 * 60_000)).toBe("1h 20m");
  });

  it("says '<1m' rather than '0m', which reads as a meeting that never happened", () => {
    expect(durationLabel(20_000)).toBe("<1m");
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(durationLabel(null)).toBe("—");
  });
});

describe("bucketFor", () => {
  it("follows the SERVER's status, not the clock", () => {
    // A scheduled time that has passed does not make a meeting live — somebody
    // still has to open it.
    const stale = call({ status: "SCHEDULED", scheduledAt: "2020-01-01T09:00:00.000Z" });
    expect(bucketFor(stale)).toBe("upcoming");
  });

  it("puts both ways of being over in Past", () => {
    expect(bucketFor(call({ status: "ENDED" }))).toBe("past");
    expect(bucketFor(call({ status: "CANCELLED" }))).toBe("past");
  });

  it("but still says CANCELLED out loud, because 'Past' would hide it", () => {
    expect(statusLabel(call({ status: "CANCELLED" }))).toBe("Cancelled");
    expect(statusLabel(call({ status: "ENDED" }))).toBe("Ended");
  });
});

describe("the bucket in the URL", () => {
  it("defaults to Upcoming, and round-trips", () => {
    expect(bucketOf(new URLSearchParams(""))).toBe("upcoming");
    expect(bucketOf(new URLSearchParams(meetingSearch("past")))).toBe("past");
    expect(bucketOf(new URLSearchParams(meetingSearch("live")))).toBe("live");
  });

  it("ignores a bucket that is not one", () => {
    expect(bucketOf(new URLSearchParams("?view=nonsense"))).toBe("upcoming");
  });

  it("keeps the default OUT of the URL, so the tidy link is the common one", () => {
    expect(meetingSearch("upcoming")).toBe("");
  });
});

describe("isMeetingDetailPath", () => {
  it("is true only for an actual meeting", () => {
    expect(isMeetingDetailPath("/app/meetings/11111111-1111-1111-1111-111111111111")).toBe(true);
  });

  it("is false for the list routes it sits beside", () => {
    expect(isMeetingDetailPath("/app/meetings")).toBe(false);
    expect(isMeetingDetailPath("/app/meetings/all")).toBe(false);
  });
});
