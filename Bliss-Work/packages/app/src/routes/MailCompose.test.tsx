/**
 * Regression coverage for a Send-vs-Discard/Close race: clicking Discard or
 * Close while a send was still in flight fired useMailDraft's discard/cleanup
 * call concurrently with the sendMail request against the SAME draft —
 * contradictory toasts, and a possible forced navigation from send's own
 * onSuccess landing after the user had already left. Only the Send button
 * used to be disabled during send.isPending; Discard and Close (both the
 * header icon and the footer button) now are too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SendMailResultDTO, UserDTO } from "@taskboard/shared";

const MAIL_ID = "018f0000-0000-7000-8000-0000000000d1";

const api = {
  createMailDraft: vi.fn(async () => ({ mailId: MAIL_ID })),
  saveMailDraft: vi.fn(async () => {}),
  discardMailDraft: vi.fn(async () => {}),
  sendMail: vi.fn(),
  directory: vi.fn(async () => [] as UserDTO[]),
  uploadAttachment: vi.fn(),
  removeDraftAttachment: vi.fn(async () => {}),
};

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config: {} }),
}));

import { MailCompose } from "./MailCompose";

function renderCompose() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/mail/compose"]}>
        <Routes>
          <Route path="/app/mail/compose" element={<MailCompose />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Fills the To field with one valid address and commits it as a chip, the
 *  minimum needed for canSend to allow pressing Send. */
async function addressAndReady(user: ReturnType<typeof userEvent.setup>) {
  const to = await screen.findByPlaceholderText("name@company.com");
  await user.type(to, "partner@outside.test{Enter}");
  await waitFor(() => expect(screen.getByRole("button", { name: /^send$/i })).not.toBeDisabled());
}

function sendResult(over: Partial<SendMailResultDTO> = {}): SendMailResultDTO {
  return { mailId: MAIL_ID, sentAt: "2026-09-02T09:00:00.000Z", deliveredInApp: 0, queuedExternal: 1, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.createMailDraft.mockResolvedValue({ mailId: MAIL_ID });
  api.directory.mockResolvedValue([]);
  api.discardMailDraft.mockResolvedValue(undefined);
  api.saveMailDraft.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MailCompose — Discard/Close during a send", () => {
  it("disables Discard, the footer Close, and the header Close while sendMail is in flight", async () => {
    const user = userEvent.setup();
    let resolveSend!: (v: SendMailResultDTO) => void;
    api.sendMail.mockReturnValue(new Promise<SendMailResultDTO>((res) => (resolveSend = res)));
    renderCompose();
    await addressAndReady(user);

    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(api.sendMail).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close — keeps this in Drafts" })).toBeDisabled();

    // Clicking a disabled control must not fire the underlying handler.
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(api.discardMailDraft).not.toHaveBeenCalled();

    resolveSend(sendResult());
    await waitFor(() => expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument());
  });

  it("leaves Discard and Close enabled before any send has been attempted", async () => {
    const user = userEvent.setup();
    api.sendMail.mockResolvedValue(sendResult());
    renderCompose();
    await addressAndReady(user);

    expect(screen.getByRole("button", { name: "Discard" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Close — keeps this in Drafts" })).not.toBeDisabled();
  });

  it("re-enables Discard and Close if the send fails", async () => {
    const user = userEvent.setup();
    api.sendMail.mockRejectedValueOnce(new Error("boom"));
    renderCompose();
    await addressAndReady(user);

    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Discard" })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: "Close" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Close — keeps this in Drafts" })).not.toBeDisabled();
  });
});
