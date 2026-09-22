/**
 * The composer is one <form> with a submit button, and a single-line input in such
 * a form submits it on Enter. Nothing intercepted that, and `canSend` needs only a
 * valid recipient, so "type a subject, press Enter to move on" sent the mail, with
 * an empty body, no confirmation and no undo. A second Enter in an empty address
 * field did the same.
 *
 * Runs the real MailCompose; only the network-facing hooks (the draft and the
 * attachment tray) are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  api: {
    sendMail: vi.fn(),
    mail: vi.fn(),
    directory: vi.fn(async () => []),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../features/useMailDraft", () => ({
  useMailDraft: () => ({
    mailId: "draft-1",
    save: vi.fn(),
    markSent: vi.fn(),
    discard: vi.fn(),
    retry: vi.fn(),
    isError: false,
    isLoading: false,
  }),
}));
vi.mock("../features/MailAttachments", () => ({
  useMailAttachments: () => ({
    files: [],
    isUploading: false,
    isRemoving: false,
    pick: vi.fn(),
    clear: vi.fn(),
    inputProps: { type: "file", hidden: true },
  }),
  MailAttachmentTray: () => null,
}));

import { MailCompose } from "./MailCompose";

function renderComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      {/* A reply-style prefill: the recipient is already valid, so canSend is true. */}
      <MemoryRouter initialEntries={[{ pathname: "/app/mail/compose", state: { to: ["bob@company.com"] } }]}>
        <Routes>
          <Route path="/app/mail/compose" element={<MailCompose />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The To field's input — its placeholder disappears once a chip is present. */
const addressInput = () => screen.getAllByRole("textbox")[0]!;

beforeEach(() => {
  h.api.sendMail.mockReset();
  h.api.sendMail.mockResolvedValue({ mailId: "draft-1", deliveredInApp: 1, queuedExternal: 0 });
});

describe("MailCompose", () => {
  it("does not send when Enter is pressed in the Subject field", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.type(screen.getByPlaceholderText("What is this about?"), "Hello{Enter}");

    expect(h.api.sendMail).not.toHaveBeenCalled();
  });

  it("does not send when Enter is pressed in an empty address field", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.click(addressInput());
    await user.keyboard("{Enter}");

    expect(h.api.sendMail).not.toHaveBeenCalled();
  });

  it("still lets Enter add the address being typed", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.type(addressInput(), "carol@company.com{Enter}");

    expect(screen.getByText("carol@company.com")).toBeInTheDocument();
    expect(h.api.sendMail).not.toHaveBeenCalled();
  });

  it("keeps Enter as a newline in the message body", async () => {
    const user = userEvent.setup();
    renderComposer();
    const body = screen.getByPlaceholderText("Write your email…");

    await user.type(body, "line one{Enter}line two");

    expect(body).toHaveValue("line one\nline two");
    expect(h.api.sendMail).not.toHaveBeenCalled();
  });

  it("sends when the Send button is pressed", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.type(screen.getByPlaceholderText("What is this about?"), "Hello");

    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(h.api.sendMail).toHaveBeenCalledTimes(1);
    expect(h.api.sendMail).toHaveBeenCalledWith("draft-1", expect.objectContaining({ subject: "Hello", to: ["bob@company.com"] }));
  });
});
