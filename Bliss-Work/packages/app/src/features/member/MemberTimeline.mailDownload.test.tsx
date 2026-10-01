import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";
import { actionLabel } from "./activityLabels";

const mocks = vi.hoisted(() => ({ activityTimeline: vi.fn() }));
vi.mock("../../lib/runtime", () => ({
  useRuntime: () => ({ api: { activityTimeline: mocks.activityTimeline } }),
}));

import { MemberTimeline } from "./MemberTimeline";

// What telemetry-svc returns for a row mapped from mail.attachment.downloaded.
const entry: TimelineEntry = {
  id: "row-1",
  occurredAt: "2026-10-01T12:00:00.000Z",
  source: "server",
  category: "engagement",
  action: "mail.attachment.downloaded",
  surface: "mail",
  targetKind: "attachment",
  targetId: "att-1",
  durationMs: null,
  detail: { filename: "Q3 deck.pdf", mime: "application/pdf", sizeBytes: "4096", mailId: "mail-1" },
};

beforeEach(() => {
  mocks.activityTimeline.mockReset().mockResolvedValue({ entries: [entry], nextCursor: null });
});

describe("mail attachment download in the activity timeline", () => {
  it("has a human label (and mobile's label-only path, with no i18n, matches)", () => {
    expect(actionLabel(entry)).toBe("Downloaded a mail attachment");
  });

  it("shows the label with the downloaded file's name and the Verified mark", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemberTimeline userId="me" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Downloaded a mail attachment")).toBeInTheDocument();
    expect(screen.getByText("Q3 deck.pdf")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });
});
