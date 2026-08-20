import { describe, expect, it } from "vitest";
import type { InboxItemDTO } from "@taskboard/shared";
import {
  MAIL_FOLDERS,
  folderOf,
  inFolder,
  isFeedFolder,
  mailSearch,
} from "./mailView";

/** A feed row. `statusBadge` is the only direction signal the feed carries. */
function row(statusBadge: string | null): InboxItemDTO {
  return {
    ownerUserId: "00000000-0000-0000-0000-000000000001",
    itemKind: "MAIL",
    refId: "00000000-0000-0000-0000-000000000002",
    peerUserId: null,
    peerUsername: null,
    preview: "Subject — body",
    lastEventAt: "2026-08-19T09:00:00.000Z",
    unreadCount: 0,
    statusBadge,
    hiddenForOwner: false,
    deletedForOwner: false,
  } as InboxItemDTO;
}

describe("the folders a mailbox has", () => {
  it("backs all of them with a listing", () => {
    const keys = MAIL_FOLDERS.map((f) => f.key);
    for (const folder of ["inbox", "sent", "drafts", "deleted", "favorites"] as const) {
      expect(keys, `${folder} should list`).toContain(folder);
    }
    expect(MAIL_FOLDERS.find((f) => f.key === "favorites")?.label).toBe("Favorites");
  });

  it("reads three of them from the unified feed and Drafts from its own listing", () => {
    expect(isFeedFolder("inbox")).toBe(true);
    expect(isFeedFolder("sent")).toBe(true);
    expect(isFeedFolder("deleted")).toBe(true);
    // A draft is in nobody's inbox_items, so the message column must not try to
    // page the feed for it.
    expect(isFeedFolder("drafts")).toBe(false);
    expect(isFeedFolder("favorites")).toBe(true);
  });
});

describe("which folder a feed row belongs to", () => {
  it("splits Inbox from Sent Items by direction", () => {
    const sent = row("SENT");
    const received = row(null);
    expect(inFolder(sent, "sent")).toBe(true);
    expect(inFolder(sent, "inbox")).toBe(false);
    expect(inFolder(received, "inbox")).toBe(true);
    expect(inFolder(received, "sent")).toBe(false);
  });

  it("keeps every row the deleted feed returns, incoming and outgoing alike", () => {
    // Deleted Items is a DIFFERENT request — the same feed with its visibility
    // predicate inverted — so its rows are already in that folder and must not
    // be split by direction again. A wastebasket holds both sides.
    expect(inFolder(row("SENT"), "deleted")).toBe(true);
    expect(inFolder(row(null), "deleted")).toBe(true);
  });

  it("never files a feed row under Drafts or Favorites without a favorite mark", () => {
    expect(inFolder(row(null), "drafts")).toBe(false);
    expect(inFolder(row("SENT"), "favorites")).toBe(false);
    expect(inFolder(row(null), "favorites", true)).toBe(true);
  });
});

describe("the folder in the URL", () => {
  it("round-trips every folder through ?box=", () => {
    for (const spec of MAIL_FOLDERS) {
      const search = mailSearch(spec.key);
      expect(folderOf(new URLSearchParams(search))).toBe(spec.key);
    }
  });

  it("keeps the plain mailbox at a clean URL and survives a person filter", () => {
    expect(mailSearch("inbox")).toBe("");
    const peer = "00000000-0000-0000-0000-000000000009";
    const params = new URLSearchParams(mailSearch("deleted", peer));
    expect(folderOf(params)).toBe("deleted");
    expect(params.get("p")).toBe(peer);
  });
});
