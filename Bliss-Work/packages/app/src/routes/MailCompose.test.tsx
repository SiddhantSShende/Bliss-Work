/**
 * The mail composer's two load-bearing behaviours.
 *
 * ── The draft lifecycle ──────────────────────────────────────────────────────
 * A server-side draft is opened when the composer MOUNTS, before anything is
 * typed, because an attachment upload has to be authorized against a
 * destination that already exists. The cost of that is a row per compose, so
 * leaving without sending has to discard it — and leaving AFTER sending must
 * not, because a sent mail is no longer a draft and the discard would 409.
 *
 * ── The Send gate ────────────────────────────────────────────────────────────
 * Send is blocked on the same rules the server enforces, so a bad address is
 * caught before a round trip rather than after. The rules are pinned here
 * because a gate that is wrong in either direction is a real failure: too
 * strict makes a deliverable mail unsendable, too loose turns a typo into a
 * failed send the user only learns about afterwards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const MAIL_ID = "018f0000-0000-7000-8000-0000000000aa";

const api = {
  createMailDraft: vi.fn(async () => ({ mailId: MAIL_ID })),
  discardMailDraft: vi.fn(async () => undefined),
  sendMail: vi.fn(async () => ({
    mailId: MAIL_ID,
    sentAt: "2026-08-18T09:00:00.000Z",
    deliveredInApp: 1,
    queuedExternal: 0,
  })),
  uploadAttachment: vi.fn(),
  directory: vi.fn(async () => []),
};

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: { kind: "web" } }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MailCompose } from "./MailCompose";

function renderComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/inbox/compose"]}>
        <Routes>
          <Route path="/app/inbox/compose" element={<MailCompose />} />
          <Route path="/app/inbox/mail/:mailId" element={<div>mail view</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MailCompose draft lifecycle", () => {
  it("opens a draft on mount so attachments have somewhere to upload to", async () => {
    renderComposer();
    await waitFor(() => expect(api.createMailDraft).toHaveBeenCalledTimes(1));
  });

  it("discards the draft when the composer is left without sending", async () => {
    const { unmount } = renderComposer();
    await waitFor(() => expect(api.createMailDraft).toHaveBeenCalled());

    unmount();
    await waitFor(() => expect(api.discardMailDraft).toHaveBeenCalledWith(MAIL_ID));
  });

  // Closing the composer while creation is still in flight is the case a
  // cache-read cleanup gets wrong: it sees no id yet and leaks the row that
  // lands a moment later. Holding the promise is what makes the release wait
  // for the resource it is releasing.
  it("still discards a draft that arrives after the composer has closed", async () => {
    let resolveDraft: (v: { mailId: string }) => void = () => undefined;
    api.createMailDraft.mockReturnValueOnce(
      new Promise<{ mailId: string }>((resolve) => {
        resolveDraft = resolve;
      }),
    );

    const { unmount } = renderComposer();
    await waitFor(() => expect(api.createMailDraft).toHaveBeenCalled());

    unmount();
    expect(api.discardMailDraft).not.toHaveBeenCalled();

    resolveDraft({ mailId: MAIL_ID });
    await waitFor(() => expect(api.discardMailDraft).toHaveBeenCalledWith(MAIL_ID));
  });

  // A sent mail is no longer a draft. Discarding it would 409 — and if it ever
  // stopped 409ing, it would delete a mail other people already have.
  it("does not discard after a successful send", async () => {
    const user = userEvent.setup();
    const { unmount } = renderComposer();
    await waitFor(() => expect(api.createMailDraft).toHaveBeenCalled());

    await user.type(screen.getByLabelText("To"), "partner@outside.test,");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(api.sendMail).toHaveBeenCalled());

    unmount();
    expect(api.discardMailDraft).not.toHaveBeenCalled();
  });
});

describe("MailCompose send gate", () => {
  it("blocks Send until there is a recipient", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitFor(() => expect(api.createMailDraft).toHaveBeenCalled());

    const send = screen.getByRole("button", { name: /send/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("To"), "partner@outside.test,");
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
  });

  it("blocks Send on a malformed address and names the one that is wrong", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitFor(() => expect(api.createMailDraft).toHaveBeenCalled());

    await user.type(screen.getByLabelText("To"), "partner@outside.test,not-an-address,");

    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("not-an-address");
  });

  // Pressing Send with a half-typed address in the box must not silently drop
  // it — the field commits on blur, which is what submitting causes.
  it("sends the addresses the user actually typed, normalized", async () => {
    const user = userEvent.setup();
    renderComposer();
    await waitFor(() => expect(api.createMailDraft).toHaveBeenCalled());

    await user.type(screen.getByLabelText("To"), "Partner@Outside.test,");
    await user.type(screen.getByLabelText("Subject"), "Q3 numbers");
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(api.sendMail).toHaveBeenCalled());
    expect(api.sendMail).toHaveBeenCalledWith(MAIL_ID, {
      to: ["partner@outside.test"],
      cc: [],
      bcc: [],
      subject: "Q3 numbers",
      bodyText: "",
    });
  });
});
