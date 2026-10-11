/**
 * File activity in the member timeline: the name, then — quieter — where it was.
 * The platform column and the row's shape are unchanged, and a row recorded before
 * the context existed reads exactly as it always did.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";

const mocks = vi.hoisted(() => ({ activityTimeline: vi.fn() }));
vi.mock("../../lib/runtime", () => ({
  useRuntime: () => ({ api: { activityTimeline: mocks.activityTimeline } }),
}));

import { MemberTimeline } from "./MemberTimeline";

let n = 0;
const row = (
  action: string,
  detail: Record<string, string> | null,
  over: Partial<TimelineEntry> = {},
): TimelineEntry => ({
  id: `row-${++n}`,
  occurredAt: "2026-10-01T12:00:00.000Z",
  source: "web",
  category: action.startsWith("file.") ? "security" : "engagement",
  action,
  surface: "chats",
  targetKind: "attachment",
  targetId: "att-1",
  durationMs: null,
  detail,
  ...over,
});

const OPENED_DM = row("attachment.opened", {
  filename: "image.png",
  conversation: "cv-1",
  contextKind: "direct",
  contextId: "cv-1",
  contextName: "Divya Bhamri",
});
const DOWNLOADED_CHANNEL = row("attachment.downloaded", {
  filename: "Text Extraction CSV Data Report.pdf",
  channel: "ch-1",
  contextKind: "channel",
  contextId: "ch-1",
  contextName: "GRC Development",
});
const LEGACY = row("attachment.opened", { filename: "Report.pdf", channel: "ch-0" });

function renderTimeline() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemberTimeline userId="me" />
    </QueryClientProvider>,
  );
}

const li = (text: string) => screen.getByText(text).closest("li")!;

beforeEach(() => {
  mocks.activityTimeline.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
});

describe("file activity in the timeline", () => {
  beforeEach(() => {
    mocks.activityTimeline.mockResolvedValue({ entries: [OPENED_DM, DOWNLOADED_CHANNEL, LEGACY], nextCursor: null });
  });

  it("names the 1:1 chat under a file that was opened in it", async () => {
    renderTimeline();
    await screen.findAllByText("Opened a file");

    const r = within(li("image.png"));
    expect(r.getByText("Opened a file")).toBeInTheDocument();
    expect(r.getByText("image.png")).toBeInTheDocument();
    expect(r.getByText("in Chat with Divya Bhamri")).toBeInTheDocument();
    expect(r.getByText("Web app")).toBeInTheDocument();
  });

  it("names the channel under a file that was downloaded from it", async () => {
    renderTimeline();
    await screen.findByText("Downloaded a file");

    const r = within(li("Text Extraction CSV Data Report.pdf"));
    expect(r.getByText("Downloaded a file")).toBeInTheDocument();
    expect(r.getByText("in #GRC Development")).toBeInTheDocument();
  });

  it("keeps the context a quiet second line — smaller than the file name, same muted colour", async () => {
    renderTimeline();
    await screen.findByText("Downloaded a file");

    const name = screen.getByText("Text Extraction CSV Data Report.pdf");
    const where = screen.getByText("in #GRC Development");
    expect(name.className).toContain("text-sm");
    expect(where.className).toContain("text-xs");
    for (const el of [name, where]) expect(el.className).toContain("text-muted");
    expect(name.compareDocumentPosition(where) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a row recorded before the context existed as just its file name", async () => {
    renderTimeline();
    await screen.findAllByText("Opened a file");

    const r = within(li("Report.pdf"));
    expect(r.getByText("Opened a file")).toBeInTheDocument();
    expect(li("Report.pdf").textContent).not.toMatch(/\bin\b|undefined|null|unknown/i);
    // One <p> for the name and nothing for the context.
    expect(li("Report.pdf").querySelectorAll("p")).toHaveLength(1);
  });

  it("never shows a raw id", async () => {
    const { container } = renderTimeline();
    await screen.findAllByText("Opened a file");
    expect(container.textContent).not.toMatch(/cv-1|ch-1|ch-0/);
  });
});

describe("the Security view", () => {
  it("lists the file.opened / file.downloaded rows with the same words and context", async () => {
    mocks.activityTimeline.mockImplementation(async (_u: string, o: { category?: string }) => ({
      entries:
        o.category === "security"
          ? [
              row("file.opened", { filename: "image.png", contextKind: "direct", contextName: "Divya Bhamri" }, { source: "desktop" }),
              row("file.downloaded", { filename: "Report.pdf", contextKind: "channel", contextName: "GRC Development" }),
              row("screenshot.attempted", { context: "a chat", chord: "PrintScreen" }, { category: "security", surface: null, targetKind: null, targetId: null, source: "desktop" }),
            ]
          : [],
      nextCursor: null,
    }));
    renderTimeline();
    await userEvent.click(await screen.findByRole("tab", { name: "Security" }).catch(() => screen.getByText("Security")));

    expect(await screen.findByText("Opened a file")).toBeInTheDocument();
    expect(screen.getByText("Downloaded a file")).toBeInTheDocument();
    expect(screen.getByText("in Chat with Divya Bhamri")).toBeInTheDocument();
    expect(screen.getByText("in #GRC Development")).toBeInTheDocument();
    // Beside — not instead of — the security events that were already there.
    expect(screen.getByText("Screenshot attempt blocked")).toBeInTheDocument();
    // The platform column is whatever the session said.
    expect(within(li("image.png")).getByText("Desktop app")).toBeInTheDocument();
    expect(mocks.activityTimeline).toHaveBeenLastCalledWith("me", expect.objectContaining({ category: "security" }));
  });
});
