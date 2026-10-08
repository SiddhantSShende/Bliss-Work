import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";

const mocks = vi.hoisted(() => ({ activityTimeline: vi.fn() }));
vi.mock("../../lib/runtime", () => ({
  useRuntime: () => ({ api: { activityTimeline: mocks.activityTimeline } }),
}));

import { MemberTimeline } from "./MemberTimeline";

const appFocus: TimelineEntry = {
  id: "a1",
  occurredAt: "2026-10-01T12:00:00.000Z",
  source: "desktop",
  category: "app",
  action: "app.focus",
  surface: null,
  targetKind: "app",
  targetId: "chrome.exe",
  durationMs: 60_000,
  detail: null,
};

const row = (id: string, at: string, over: Partial<TimelineEntry>): TimelineEntry => ({
  ...appFocus, id, occurredAt: `2026-10-01T${at}.000Z`, ...over,
});
const explorer = row("e1", "12:05:00", { targetId: "explorer.exe", durationMs: 15_000 });
const excel = row("e2", "12:04:00", { targetId: "EXCEL.EXE", durationMs: 120_000 });
const vscode = row("e3", "12:03:00", { targetId: "Code.exe", durationMs: 90_000 });
const awayFrom = row("e4", "12:02:00", {
  category: "engagement", action: "blur", targetKind: null, targetId: null, durationMs: null,
});
const cameBack = row("e5", "12:01:00", {
  category: "engagement", action: "focus", targetKind: null, targetId: null, durationMs: null,
});
const inside = row("e6", "12:06:00", {
  source: "web", category: "engagement", action: "task.completed", targetKind: null, targetId: null, durationMs: null,
});
const OUTSIDE_ROWS = [explorer, excel, vscode, awayFrom, cameBack];
// What the server answers for each view: Everything holds the in-app row too,
// Outside Activity only the rows from outside BlissWork.
const EVERYTHING_ROWS = [inside, ...OUTSIDE_ROWS];
const serve = (opts: { category?: string }) =>
  Promise.resolve({ entries: opts.category === "outside" ? OUTSIDE_ROWS : EVERYTHING_ROWS, nextCursor: null });

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemberTimeline userId="me" />
    </QueryClientProvider>,
  );
}

const lastCategory = () => mocks.activityTimeline.mock.lastCall?.[1]?.category;

beforeEach(() => {
  mocks.activityTimeline.mockReset().mockResolvedValue({ entries: [appFocus], nextCursor: null });
});

describe("activity filters", () => {
  it("offers the filters in order, with Everything selected by default", async () => {
    mount();
    await screen.findByText("Used Google Chrome");

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Everything", "Work", "In-app", "Outside Activity", "Sign-ins", "Security"]);
    expect(screen.getByRole("tab", { name: "Everything" })).toHaveAttribute("aria-selected", "true");
    expect(lastCategory()).toBeUndefined();
  });

  it("asks the server for the outside view, rather than filtering rows itself", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Used Google Chrome");

    await user.click(screen.getByRole("tab", { name: "Outside Activity" }));
    await waitFor(() => expect(lastCategory()).toBe("outside"));
    // The row on screen is whatever the server returned for that view.
    expect(await screen.findByText("Used Google Chrome")).toBeInTheDocument();
  });

  it.each([
    ["Work", "engagement"],
    ["In-app", "navigation"],
    ["Sign-ins", "auth"],
    ["Security", "security"],
  ])("still sends %s as the %s category", async (label, category) => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Used Google Chrome");

    await user.click(screen.getByRole("tab", { name: label }));
    await waitFor(() => expect(lastCategory()).toBe(category));
  });

  it("shows the proper application name, not the executable", async () => {
    mount();
    expect(await screen.findByText("Used Google Chrome")).toBeInTheDocument();
    expect(screen.queryByText(/chrome\.exe/)).toBeNull();
  });

  describe("Outside Activity", () => {
    const OUTSIDE_TEXT = [
      "Used File Explorer",
      "Used Microsoft Excel",
      "Used Visual Studio Code",
      "Switched away from BlissWork",
      "Came back to BlissWork",
    ];
    const rowsOnScreen = () => screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const open = async () => {
      const user = userEvent.setup();
      mount();
      await screen.findByText("Completed a task");
      await user.click(screen.getByRole("tab", { name: "Outside Activity" }));
      await waitFor(() => expect(lastCategory()).toBe("outside"));
    };

    beforeEach(() => {
      mocks.activityTimeline.mockReset().mockImplementation((_user, opts) => serve(opts));
    });

    it("lists external applications and away/back, with duration and the Desktop app source", async () => {
      await open();
      for (const text of OUTSIDE_TEXT) expect(await screen.findByText(text)).toBeInTheDocument();

      const items = rowsOnScreen();
      expect(items).toHaveLength(OUTSIDE_ROWS.length);
      expect(items.find((t) => t.includes("File Explorer"))).toMatch(/15s.*Desktop app/);
      expect(items.find((t) => t.includes("Microsoft Excel"))).toMatch(/2m.*Desktop app/);
      expect(items.find((t) => t.includes("Visual Studio Code"))).toMatch(/1m.*Desktop app/);
    });

    it("does not list BlissWork's own activity", async () => {
      await open();
      await screen.findByText("Used File Explorer");
      expect(screen.queryByText("Completed a task")).toBeNull();
    });

    it("keeps the server's newest-first order", async () => {
      await open();
      await screen.findByText("Used File Explorer");
      expect(rowsOnScreen().map((t) => OUTSIDE_TEXT.findIndex((x) => t.includes(x)))).toEqual([0, 1, 2, 3, 4]);
    });

    it("shows each outside event in Everything too, worded identically and never twice", async () => {
      const user = userEvent.setup();
      mount();
      await screen.findByText("Completed a task");
      const everything = rowsOnScreen();

      for (const text of OUTSIDE_TEXT) {
        expect(everything.filter((t) => t.includes(text))).toHaveLength(1);
      }
      await user.click(screen.getByRole("tab", { name: "Outside Activity" }));
      await waitFor(() => expect(lastCategory()).toBe("outside"));
      await screen.findByText("Used File Explorer");
      const outside = rowsOnScreen();
      expect(outside.every((t) => everything.includes(t))).toBe(true);
      expect(new Set(outside).size).toBe(outside.length);
    });

    it("says so when there is no outside activity", async () => {
      mocks.activityTimeline.mockImplementation((_user, opts) =>
        Promise.resolve({ entries: opts.category === "outside" ? [] : EVERYTHING_ROWS, nextCursor: null }),
      );
      await open();
      expect(await screen.findByText("No activity recorded yet")).toBeInTheDocument();
    });

    it("shows a failure as a failure, not as an empty record", async () => {
      mocks.activityTimeline.mockImplementation((_user, opts) =>
        opts.category === "outside" ? Promise.reject(new Error("503")) : serve(opts),
      );
      await open();
      expect(await screen.findByText("Activity could not be loaded")).toBeInTheDocument();
      expect(screen.queryByText("No activity recorded yet")).toBeNull();
    });

    it("shows a spinner while the first page is loading", async () => {
      mocks.activityTimeline.mockImplementation((_user, opts) =>
        opts.category === "outside" ? new Promise(() => {}) : serve(opts),
      );
      await open();
      expect(screen.queryByText("No activity recorded yet")).toBeNull();
      expect(screen.queryByText("Activity could not be loaded")).toBeNull();
      expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    });
  });
});
