/**
 * Inbox row identity.
 *
 * The Inbox is styled after an email client and used to print the peer's EMAIL
 * ADDRESS as the row title. Every other chat surface — the chat list, the DM
 * header, a channel bubble, the thread header one click away — shows the
 * person's name, so the same colleague read as "j.okafor@acme.com" in the list
 * and "Jane Okafor" everywhere else.
 *
 * These tests pin the name as the row's identity, and pin the two fallbacks
 * that stop a missing name from regressing into a printed address: the
 * directory omits removed members, and `peerUsername` is only the email
 * local-part.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InboxItemDTO, UserDTO } from "@taskboard/shared";

const PEER_ID = "11111111-1111-4111-8111-111111111111";

const peer: UserDTO = {
  id: PEER_ID,
  orgId: "22222222-2222-4222-8222-222222222222",
  orgName: "Acme",
  username: "j.okafor",
  displayName: "Jane Okafor",
  email: "j.okafor@acme.com",
  roles: [],
  plan: "free",
};

const api = { directory: vi.fn(async () => [peer]) };

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api, config: { kind: "web" } }),
}));

import { InboxRow } from "./InboxRow";

const thread: InboxItemDTO = {
  ownerUserId: "33333333-3333-4333-8333-333333333333",
  itemKind: "THREAD",
  refId: "44444444-4444-4444-8444-444444444444",
  peerUserId: PEER_ID,
  peerUsername: "j.okafor",
  preview: "Ready for review",
  lastEventAt: new Date(0).toISOString(),
  unreadCount: 0,
  statusBadge: null,
  hiddenForOwner: false,
  deletedForOwner: false,
};

function renderRow(item: InboxItemDTO) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <InboxRow item={item} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InboxRow", () => {
  it("titles a thread row with the peer's name, not their email address", async () => {
    renderRow(thread);

    expect(await screen.findByText("Jane Okafor")).toBeTruthy();
    expect(screen.queryByText("j.okafor@acme.com")).toBeNull();
  });

  it("keeps the address reachable on hover", async () => {
    renderRow(thread);

    const title = await screen.findByText("Jane Okafor");
    expect(title.getAttribute("title")).toBe("j.okafor@acme.com");
  });

  it("falls back to the handle — never to an address — for a peer the directory no longer lists", async () => {
    api.directory.mockResolvedValueOnce([]);
    renderRow(thread);

    expect(await screen.findByText("j.okafor")).toBeTruthy();
  });

  it("titles a task row with the task, and shows no peer identity at all", async () => {
    renderRow({ ...thread, itemKind: "TASK", preview: "Ship the release notes" });

    expect(await screen.findByText("Ship the release notes")).toBeTruthy();
    expect(screen.queryByText("Jane Okafor")).toBeNull();
    expect(screen.queryByText("j.okafor@acme.com")).toBeNull();
  });

  // A mail row is the same shape as a thread row — sender's NAME on top, the
  // server-built "subject — snippet" beneath — and differs only in where it
  // goes. The preview arrives whole; nothing here re-derives it.
  it("titles a mail row with the sender's name and routes to the mail view", async () => {
    const { container } = renderRow({
      ...thread,
      itemKind: "MAIL",
      preview: "Q3 numbers — Deck attached",
    });

    expect(await screen.findByText("Jane Okafor")).toBeTruthy();
    expect(screen.getByText("Q3 numbers — Deck attached")).toBeTruthy();
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/app/inbox/mail/${thread.refId}`,
    );
  });

  // Mail from outside the org has no local account behind it, so there is no
  // directory entry to join and nameOf would fall back to a handle that does
  // not exist. Inventing a name from the preview would be worse than saying so.
  it("labels a mail with no local sender as external rather than guessing a name", async () => {
    renderRow({
      ...thread,
      itemKind: "MAIL",
      peerUserId: null,
      peerUsername: null,
      preview: "Invoice 4417 — Payment due",
    });

    expect(await screen.findByText("External sender")).toBeTruthy();
    expect(screen.getByText("Invoice 4417 — Payment due")).toBeTruthy();
  });

  // Removing a mail is one-sided, which is not what "Ignore" means on a thread
  // (that hides it for both parties). The label has to say which act it is.
  it("labels the mail row's remove action Delete, not Ignore", async () => {
    renderRow({ ...thread, itemKind: "MAIL", preview: "Q3 numbers" });
    // onIgnore is undefined in renderRow, so re-render with it wired up.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <InboxRow
            item={{ ...thread, itemKind: "MAIL", preview: "Q3 numbers" }}
            onIgnore={() => undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByLabelText("Delete")).toBeTruthy();
    expect(screen.queryByLabelText("Ignore")).toBeNull();
  });
});
