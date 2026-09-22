/**
 * /app/mail/compose and /app/mail/compose/:draftId render the same component at
 * the same place in the tree, so moving between drafts reused one mounted
 * composer. Its form was refilled from the new draft, but the attachment tray
 * only ever appended: draft A's files stayed listed under draft B, where Send
 * would treat them as part of B's mail.
 *
 * Runs the real composer, draft hook and attachment tray; only the network-facing
 * api is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  api: {
    mail: vi.fn(),
    createMailDraft: vi.fn(),
    saveMailDraft: vi.fn(),
    discardMailDraft: vi.fn(),
    sendMail: vi.fn(),
    directory: vi.fn(async () => []),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { MailCompose } from "./MailCompose";

const draft = (id: string) => ({
  mailId: id,
  subject: `Subject ${id}`,
  bodyText: `Body ${id}`,
  recipients: [{ kind: "TO", address: `${id}@company.com` }],
  attachments: [{ id: `att-${id}`, filename: `file-${id}.pdf`, sizeBytes: 1024 }],
});

function Switcher() {
  const nav = useNavigate();
  return (
    <>
      <button onClick={() => nav("/app/mail/compose/a")}>open a</button>
      <button onClick={() => nav("/app/mail/compose/b")}>open b</button>
      <button onClick={() => nav("/app/mail/compose")}>new mail</button>
    </>
  );
}

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/mail/compose/a"]}>
        <Switcher />
        <Routes>
          <Route path="/app/mail/compose" element={<MailCompose />} />
          <Route path="/app/mail/compose/:draftId" element={<MailCompose />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.api.mail.mockReset().mockImplementation(async (id: string) => draft(id));
  h.api.createMailDraft.mockReset().mockResolvedValue({ mailId: "fresh" });
  h.api.saveMailDraft.mockReset().mockResolvedValue(undefined);
  h.api.discardMailDraft.mockReset().mockResolvedValue(undefined);
});

describe("MailCompose across drafts", () => {
  it("shows only the files of the draft that is open", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByText("file-a.pdf")).toBeInTheDocument();

    await user.click(screen.getByText("open b"));

    expect(await screen.findByText("file-b.pdf")).toBeInTheDocument();
    expect(screen.queryByText("file-a.pdf")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("What is this about?")).toHaveValue("Subject b");
  });

  it("starts a new mail empty after a draft", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await screen.findByText("file-a.pdf")).toBeInTheDocument();

    await user.click(screen.getByText("new mail"));

    expect(await screen.findByPlaceholderText("What is this about?")).toHaveValue("");
    expect(screen.queryByText("file-a.pdf")).not.toBeInTheDocument();
  });
});
