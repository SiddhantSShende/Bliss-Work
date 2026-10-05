import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";
import { actionLabel } from "./activityLabels";

const entry = (action: string): TimelineEntry => ({
  id: "1",
  occurredAt: "2026-10-01T10:00:00Z",
  source: "web",
  category: "engagement",
  action,
  surface: "channels",
  targetKind: "attachment",
  targetId: "att-1",
  durationMs: null,
  detail: { filename: "Report.pdf", channel: "ch-1" },
});

describe("chat file activity labels", () => {
  it("reads an opened and a downloaded chat file in words, not as raw action ids", () => {
    expect(actionLabel(entry("attachment.opened"))).toBe("Opened a file");
    expect(actionLabel(entry("attachment.downloaded"))).toBe("Downloaded a file");
  });

  it("leaves the mail attachment label alone", () => {
    expect(actionLabel(entry("mail.attachment.downloaded"))).toBe("Downloaded a mail attachment");
  });
});
