import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";
import { actionLabel, fileContextLabel, isFileAction } from "./activityLabels";

const entry = (action: string, detail: Record<string, string> | null): TimelineEntry => ({
  id: "1",
  occurredAt: "2026-10-01T10:00:00Z",
  source: "web",
  category: action.startsWith("file.") ? "security" : "engagement",
  action,
  surface: "chats",
  targetKind: "attachment",
  targetId: "att-1",
  durationMs: null,
  detail,
});

describe("fileContextLabel — where a chat file was opened or downloaded", () => {
  it.each(["attachment.opened", "attachment.downloaded", "file.opened", "file.downloaded"])(
    "%s in a 1:1 chat reads 'in Chat with <name>'",
    (action) => {
      const e = entry(action, { filename: "image.png", contextKind: "direct", contextName: "Divya Bhamri" });
      expect(fileContextLabel(e)).toBe("in Chat with Divya Bhamri");
    },
  );

  it.each(["attachment.opened", "attachment.downloaded", "file.opened", "file.downloaded"])(
    "%s in a channel reads 'in #<name>'",
    (action) => {
      const e = entry(action, { filename: "Report.pdf", contextKind: "channel", contextName: "GRC Development" });
      expect(fileContextLabel(e)).toBe("in #GRC Development");
    },
  );

  it.each([
    ["a row recorded before the context existed", { filename: "Report.pdf", channel: "ch-1" }],
    ["no detail at all", null],
    ["a context kind with no name", { filename: "a.pdf", contextKind: "channel" }],
    ["a blank name", { filename: "a.pdf", contextKind: "channel", contextName: "   " }],
    ["a name with no kind", { filename: "a.pdf", contextName: "GRC Development" }],
    ["a kind this client does not know", { filename: "a.pdf", contextKind: "meeting", contextName: "Standup" }],
  ])("is null — nothing drawn — for %s", (_label, detail) => {
    expect(fileContextLabel(entry("attachment.opened", detail))).toBeNull();
  });

  it("never invents text for a legacy row", () => {
    const text = fileContextLabel(entry("attachment.opened", { filename: "Report.pdf" })) ?? "";
    expect(text).not.toMatch(/undefined|null|unknown/i);
  });

  it("is null for every other kind of row, including a mail attachment", () => {
    const withContext = { filename: "a.pdf", contextKind: "channel", contextName: "ops" };
    expect(fileContextLabel(entry("mail.attachment.downloaded", withContext))).toBeNull();
    expect(fileContextLabel(entry("message.sent", withContext))).toBeNull();
    expect(fileContextLabel(entry("screenshot.attempted", withContext))).toBeNull();
  });
});

describe("the Security view's twin actions", () => {
  it("read in words, the same as the activity rows they are derived from", () => {
    expect(actionLabel(entry("file.opened", null))).toBe("Opened a file");
    expect(actionLabel(entry("file.downloaded", null))).toBe("Downloaded a file");
    expect(isFileAction("file.opened")).toBe(true);
    expect(isFileAction("message.sent")).toBe(false);
  });
});
