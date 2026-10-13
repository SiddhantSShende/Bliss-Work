/**
 * The Danger zone heading and the "Delete this workspace…" button swapped
 * their VISUAL formatting only — same DOM position, same content, same
 * confirm-flow behavior. This guards both halves of that: the look really
 * swapped, and nothing about what the section does moved or broke.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrgLifecycleDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  api: { org: vi.fn(), requestOrgDelete: vi.fn(), cancelOrgDelete: vi.fn() },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DeleteOrgSection } from "./DeleteOrgSection";

const ORG: OrgLifecycleDTO = { id: "org-1", name: "Acme", slug: "acme", purgeAfter: null };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DeleteOrgSection />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

beforeEach(() => {
  h.api.org.mockReset().mockResolvedValue(ORG);
  h.api.requestOrgDelete.mockReset();
  h.api.cancelOrgDelete.mockReset();
});

describe("DeleteOrgSection — Danger zone formatting swap", () => {
  it("keeps the heading first and the open-button second in the DOM, each still showing its own text", async () => {
    mount();
    const heading = await screen.findByRole("heading", { name: /danger zone/i });
    const openButton = screen.getByRole("button", { name: /delete this workspace/i });

    expect(heading.compareDocumentPosition(openButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives the heading the button's old pill-chip classes (accent-soft background, not danger text)", async () => {
    mount();
    const heading = await screen.findByRole("heading", { name: /danger zone/i });
    expect(heading.className).toContain("bg-accent-soft");
    expect(heading.className).toContain("text-accent");
    expect(heading.className).not.toContain("text-danger");
  });

  it("gives the open button the heading's old plain danger-text classes (no pill background)", async () => {
    mount();
    const openButton = await screen.findByRole("button", { name: /delete this workspace/i });
    expect(openButton.className).toContain("text-danger");
    expect(openButton.className).toContain("font-semibold");
    expect(openButton.className).not.toContain("bg-accent-soft");
  });

  it("still opens the confirm flow and still completes the real deletion request", async () => {
    h.api.requestOrgDelete.mockResolvedValue({ ...ORG, purgeAfter: "2026-11-01T00:00:00.000Z" });
    const { user } = mount();

    await user.click(await screen.findByRole("button", { name: /delete this workspace/i }));
    const input = screen.getByLabelText(/confirm/i);
    await user.type(input, "acme");
    await user.click(screen.getByRole("button", { name: /^delete workspace$/i }));

    expect(h.api.requestOrgDelete).toHaveBeenCalledWith("acme");
  });
});
