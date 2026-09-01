/**
 * Multi-source, multi-destination forward.
 *
 * The dialog used to hard-code a single `Target | null` and refuse more than
 * one destination — see its own doc comment for why that changed. What
 * matters here: selection is a Set independent of the search query (so
 * filtering never drops a pick), a multi-message forward still sends every
 * source id, and the request carries every selected destination in one call
 * rather than fanning out N separate ones.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  forwardMessages: vi.fn(
    async (_input: {
      messageIds: string[];
      targets: { kind: "user" | "channel"; id: string }[];
      clientBatchId?: string;
    }) => ({ results: [] as unknown[] }),
  ),
}));

const PEOPLE = [
  { id: "u-1", username: "mayank", displayName: "Mayank", email: "mayank@acme.test" },
  { id: "u-2", username: "siddhant", displayName: "Siddhant", email: "siddhant@acme.test" },
];
const CHANNELS = [{ id: "c-1", name: "dev-team", myRole: "member" }];

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({
    api: {
      directory: vi.fn(async () => PEOPLE),
      channels: vi.fn(async () => CHANNELS),
      forwardMessages: h.forwardMessages,
    },
    config: {},
  }),
}));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: unknown) => unknown) => sel({ user: { id: "me" } }),
}));
vi.mock("../lib/selectedChat", () => ({
  useSelectedChat: () => ({ openChat: vi.fn() }),
}));

import { ForwardToDialog } from "./ForwardToDialog";

function renderDialog(props: Partial<React.ComponentProps<typeof ForwardToDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ForwardToDialog
          open
          onClose={onClose}
          sourceMessageIds={["m-1"]}
          onDone={onDone}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose, onDone, user: userEvent.setup() };
}

describe("ForwardToDialog — multi-destination selection", () => {
  it("selects multiple destinations across people and channels", async () => {
    const { user } = renderDialog();
    await screen.findByText("Mayank");

    await user.click(screen.getByText("Mayank"));
    await user.click(screen.getByText("Siddhant"));
    await user.click(screen.getByText("dev-team"));

    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Forward to 3 destinations/ })).toBeInTheDocument();
  });

  it("keeps a selection intact across searching and clearing the search", async () => {
    const { user } = renderDialog();
    // Once selected, "Forward to Mayank" also names Mayank — this is
    // deliberately the FIRST such button, the list row, not the confirm one.
    const mayankRow = () => screen.getAllByRole("button", { name: /Mayank/ })[0]!;
    await screen.findByText("Mayank");
    await user.click(screen.getByText("Mayank"));
    expect(mayankRow()).toHaveAttribute("aria-pressed", "true");

    // Filters Mayank out of the visible list entirely.
    await user.type(screen.getByPlaceholderText("Search people and channels…"), "dev-team");
    expect(screen.queryByText("Mayank")).toBeNull();
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    // Clearing the search brings the row back, still selected.
    await user.clear(screen.getByPlaceholderText("Search people and channels…"));
    expect(mayankRow()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("sends every selected destination, and every source message id, in one request", async () => {
    const { user, onDone } = renderDialog({ sourceMessageIds: ["m-1", "m-2", "m-3"] });
    await screen.findByText("Mayank");

    await user.click(screen.getByText("Mayank"));
    await user.click(screen.getByText("dev-team"));
    await user.click(screen.getByRole("button", { name: /Forward to 2 destinations/ }));

    await vi.waitFor(() => expect(h.forwardMessages).toHaveBeenCalled());
    const call = h.forwardMessages.mock.calls[0]![0];
    expect(call.messageIds).toEqual(["m-1", "m-2", "m-3"]);
    expect(call.targets).toEqual(
      expect.arrayContaining([
        { kind: "user", id: "u-1" },
        { kind: "channel", id: "c-1" },
      ]),
    );
    expect(call.targets).toHaveLength(2);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("disables the confirm button until at least one destination is selected", async () => {
    renderDialog();
    await screen.findByText("Mayank");
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });
});
