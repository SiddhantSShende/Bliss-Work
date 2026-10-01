import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { notificationPathFor, popupFor } from "./notifier";

/**
 * Read state belongs to the shared bell panel (packages/app), which the desktop
 * renderer mounts unchanged: opening or closing it never marks anything read,
 * and only an explicit row action does. The desktop shell must stay out of it —
 * an OS popup, its click, or the window opening/closing is not the user reading
 * a notification. These tests pin that boundary.
 */

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("desktop shell and notification read state", () => {
  it("never calls an API that changes a notification's read state", () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      /markNotificationRead|readAllNotifications|notifications\/read-all|\/notifications\/[^"'`\s]*\/read/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("raises a popup for a realtime record without altering the record", () => {
    const record = {
      type: "notification.created",
      recipientId: "me",
      notificationId: "n1",
      kind: "DM_MESSAGE",
      text: "Ann: hi",
      conversationId: "018f0000-0000-7000-8000-0000000000d4",
    };
    const before = JSON.stringify(record);

    const popup = popupFor(record, "me");
    notificationPathFor(record, "me");

    // The popup names the persisted row (the bell's own record) and nothing else
    // about it changes: no `read` flag is added or set.
    expect(popup?.notificationId).toBe("n1");
    expect(JSON.stringify(record)).toBe(before);
  });
});
