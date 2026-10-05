/**
 * InviteePicker is shared: the call-link dialog uses it in the app's themed
 * surface, and the meeting form uses it in a white card. The default must stay
 * exactly what the first caller has always had; the variant must not leak into it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../store/session";
import { ADA, DIRECTORY, ME } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({ api: { directory: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { InviteePicker } from "./InviteePicker";

function renderPicker(props: Partial<React.ComponentProps<typeof InviteePicker>> = {}) {
  const onToggle = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InviteePicker selected={new Set([ADA.id])} onToggle={onToggle} {...props} />
    </QueryClientProvider>,
  );
  return { onToggle, user: userEvent.setup() };
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.directory.mockReset().mockResolvedValue(DIRECTORY);
});

describe("the default (themed) look", () => {
  it("uses the theme tokens, as it always has", async () => {
    renderPicker();
    const search = screen.getByRole("textbox", { name: "Search your organisation" });
    expect(search.className).toContain("bg-surface-2");
    expect(search.className).toContain("text-fg");
    expect(search.className).not.toContain("bg-white");
    const row = await screen.findByRole("button", { name: /Ada Lovelace/ });
    expect(row.className).toContain("bg-accent-soft"); // selected
    expect((await screen.findByRole("button", { name: /Grace Hopper/ })).className).toContain("hover:bg-surface-2");
  });

  it("does not steal focus unless asked", () => {
    renderPicker();
    expect(screen.getByRole("textbox", { name: "Search your organisation" })).not.toHaveFocus();
  });
});

describe("the light variant", () => {
  it("is white and grey in every theme", async () => {
    renderPicker({ tone: "light" });
    const search = screen.getByRole("textbox", { name: "Search your organisation" });
    expect(search.className).toContain("bg-white");
    expect(search.className).toContain("text-gray-900");
    expect(search.className).not.toContain("bg-surface-2");
    expect((await screen.findByRole("button", { name: /Ada Lovelace/ })).className).toContain("bg-accent/10");
  });

  it("can take focus on open", () => {
    renderPicker({ tone: "light", autoFocus: true });
    expect(screen.getByRole("textbox", { name: "Search your organisation" })).toHaveFocus();
  });
});

describe("behaviour common to both", () => {
  it("toggles a person, and reports it", async () => {
    const { onToggle, user } = renderPicker();
    await user.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    expect(onToggle).toHaveBeenCalledWith(DIRECTORY[2]!.id);
  });

  it("marks who is selected for assistive technology", async () => {
    renderPicker();
    expect(await screen.findByRole("button", { name: /Ada Lovelace/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Grace Hopper/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("leaves out anyone excluded", async () => {
    renderPicker({ exclude: new Set([ADA.id]) });
    await screen.findByRole("button", { name: /Grace Hopper/ });
    expect(screen.queryByRole("button", { name: /Ada Lovelace/ })).not.toBeInTheDocument();
  });
});
