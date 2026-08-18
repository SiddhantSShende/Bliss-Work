/**
 * The mail detail view — the only place a mail actually exists to its reader.
 *
 * The feed row carries a one-line preview and no body at all, so if something
 * is not rendered here it is not reachable anywhere. These tests pin the three
 * things that are easy to lose: the complete body (untruncated), the header
 * (including which side of the mail the reader is on), and mark-as-read, which
 * is the only thing that clears the unread badge for someone who opens a mail
 * directly rather than by clicking through the People sidebar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MailDTO } from "@taskboard/shared";

const MAIL_ID = "018f0000-0000-7000-8000-0000000000aa";

const mail: MailDTO = {
  mailId: MAIL_ID,
  status: "SENT",
  folder: "INBOX",
  fromAddress: "jane@acme.test",
  fromName: "Jane Okafor",
  fromUserId: "018f0000-0000-7000-8000-0000000000bb",
  subject: "Q3 numbers",
  bodyText: "Deck attached.\n\nSecond paragraph that a preview would have cut.",
  bodyHtml: null,
  recipients: [
    { kind: "TO", address: "me@acme.test", userId: null, displayName: "Me" },
    { kind: "CC", address: "cc@acme.test", userId: null, displayName: null },
  ],
  attachments: [
    { id: "018f0000-0000-7000-8000-0000000000cc", filename: "deck.pdf", mime: "application/pdf", sizeBytes: 2_400_000 },
  ],
  sentAt: "2026-08-18T09:00:00.000Z",
  readAt: null,
};

const api = {
  mail: vi.fn(async () => mail),
  readMail: vi.fn(async () => undefined),
  ignoreInboxItem: vi.fn(async () => undefined),
  attachmentLinks: vi.fn(async () => [
    { id: mail.attachments[0]!.id, url: "/media/x?t=sig" },
  ]),
  mediaUrl: (p: string) => `https://msg.test${p}`,
};

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MailDetail } from "./MailDetail";

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/inbox/mail/${MAIL_ID}`]}>
        <Routes>
          <Route path="/app/inbox/mail/:mailId" element={<MailDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.mail.mockResolvedValue(mail);
});

describe("MailDetail", () => {
  it("renders the complete body, not a preview of it", async () => {
    renderDetail();
    expect(
      await screen.findByText(/Second paragraph that a preview would have cut/),
    ).toBeTruthy();
  });

  it("shows the sender, the recipient header and the subject", async () => {
    renderDetail();
    expect(await screen.findByText("Q3 numbers")).toBeTruthy();
    expect(screen.getByText("Jane Okafor")).toBeTruthy();
    expect(screen.getByText("jane@acme.test")).toBeTruthy();
    // The label is its own span inside the line, so assert on the line.
    expect(screen.getByText(/To:/).parentElement?.textContent).toContain("Me");
    expect(screen.getByText(/Cc:/).parentElement?.textContent).toContain("cc@acme.test");
  });

  // The same row is somebody's Sent and somebody else's Inbox, and which one
  // you are looking at changes what the actions mean.
  it("says which side of the mail the reader is on", async () => {
    renderDetail();
    expect(await screen.findByText("inbox")).toBeTruthy();

    api.mail.mockResolvedValue({ ...mail, folder: "SENT" });
    renderDetail();
    expect(await screen.findAllByText("sent")).toBeTruthy();
  });

  it("marks the mail read on open so the badge clears", async () => {
    renderDetail();
    await waitFor(() => expect(api.readMail).toHaveBeenCalledWith(MAIL_ID));
  });

  // Idempotent server-side, but re-posting on every open is pointless traffic
  // on the busiest surface in the app.
  it("does not re-mark a mail that is already read", async () => {
    api.mail.mockResolvedValue({ ...mail, readAt: "2026-08-18T09:05:00.000Z" });
    renderDetail();
    await screen.findByText("Q3 numbers");
    expect(api.readMail).not.toHaveBeenCalled();
  });

  it("offers each attachment behind a signed download link", async () => {
    renderDetail();
    const link = await screen.findByRole("link", { name: /download/i });
    expect(link.getAttribute("href")).toBe("https://msg.test/media/x?t=sig");
    expect(screen.getByText("deck.pdf")).toBeTruthy();
    expect(screen.getByText("2.3 MB")).toBeTruthy();
  });

  it("says so plainly when the mail cannot be opened", async () => {
    api.mail.mockRejectedValue(new Error("not found"));
    renderDetail();
    expect(await screen.findByText(/could not be opened/i)).toBeTruthy();
  });
});
