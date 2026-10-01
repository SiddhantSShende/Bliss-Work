import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskParticipantDTO } from "@taskboard/shared";
import { trackUnhandledRejections } from "../test/unhandledRejections";

// The picker searches the directory and channels over the network; what matters
// here is what TaskParticipants does with the targets it hands back.
vi.mock("./AddParticipantsPicker", () => ({
  AddParticipantsPicker: (p: { onConfirm: (targets: { userIds: string[]; channelIds: string[] }) => void; busy?: boolean }) => (
    <button type="button" disabled={p.busy} onClick={() => p.onConfirm({ userIds: ["u-new"], channelIds: ["c-new"] })}>
      pick a member
    </button>
  ),
}));

import { TaskParticipants } from "./TaskParticipants";

const person = (userId: string, username: string, status: TaskParticipantDTO["status"]) =>
  ({ userId, username, status }) as TaskParticipantDTO;

const people = [
  person("u-sent", "piyush", "SENT"),
  person("u-ack", "divya", "ACKNOWLEDGED"),
  person("u-done", "mayank", "COMPLETED"),
  person("u-left", "siddhant", "LEFT"),
  person("u-ign", "luv", "IGNORED"),
  person("u-boss", "boss", "ACKNOWLEDGED"),
];

function renderParticipants(props: Partial<React.ComponentProps<typeof TaskParticipants>> = {}) {
  const onAdd = vi.fn(async () => {});
  const onWithdraw = vi.fn(async () => {});
  render(
    <TaskParticipants
      participants={people}
      currentUserId="u-boss"
      allocatorId="u-boss"
      layout="list"
      onAdd={onAdd}
      onWithdraw={onWithdraw}
      {...props}
    />,
  );
  return { onAdd, onWithdraw };
}
const withdrawButtons = () => screen.queryAllByRole("button", { name: /^Withdraw / }).map((b) => b.getAttribute("aria-label"));

describe("TaskParticipants list layout", () => {
  it("puts a labelled Withdraw button beside each SENT and ACKNOWLEDGED person, and nobody else", () => {
    renderParticipants();

    // Not the allocator themself (that is Leave), and not COMPLETED / LEFT / IGNORED.
    expect(withdrawButtons()).toEqual(["Withdraw piyush", "Withdraw divya"]);
    // Visible text, not just a tooltip or an aria-label on a bare glyph.
    for (const button of screen.getAllByRole("button", { name: /^Withdraw / })) {
      expect(button).toHaveTextContent("Withdraw");
    }
  });

  it("still lists everyone, including the people who cannot be withdrawn", () => {
    renderParticipants();
    for (const name of ["piyush", "divya", "mayank", "siddhant", "luv"]) expect(screen.getByText(name)).toBeInTheDocument();
  });

  it("calls onWithdraw with the person on that row", async () => {
    const user = userEvent.setup();
    const { onWithdraw } = renderParticipants();

    await user.click(screen.getByRole("button", { name: "Withdraw divya" }));
    expect(onWithdraw).toHaveBeenCalledExactlyOnceWith("u-ack");
  });

  it("offers Add member to the allocator and hands the picked ids to onAdd", async () => {
    const user = userEvent.setup();
    const { onAdd } = renderParticipants();

    await user.click(screen.getByRole("button", { name: "Add member" }));
    await user.click(await screen.findByRole("button", { name: "pick a member" }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith({ userIds: ["u-new"], channelIds: ["c-new"] });
  });

  it("offers neither once nobody is on an open assignment", () => {
    renderParticipants({ participants: [person("u-done", "mayank", "COMPLETED"), person("u-left", "siddhant", "LEFT")] });

    expect(withdrawButtons()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
  });
});

describe("TaskParticipants when Withdraw fails", () => {
  // The consumer's mutation has already shown the error toast by the time
  // onWithdraw rejects, so the component only has to swallow the rejection and
  // let the user try again. Left unhandled it surfaces as a console error.
  it.each(["list", "chips"] as const)("handles the rejection and re-enables the button (%s layout)", async (layout) => {
    const rejections = trackUnhandledRejections();
    try {
      const user = userEvent.setup();
      const onWithdraw = vi.fn(async () => {
        throw new Error("participant is no longer active on this task");
      });
      renderParticipants({ layout, onWithdraw });

      await user.click(screen.getByRole("button", { name: "Withdraw piyush" }));
      expect(onWithdraw).toHaveBeenCalledExactlyOnceWith("u-sent");

      expect(await rejections.unhandled()).toEqual([]);
      await waitFor(() => expect(screen.getByRole("button", { name: "Withdraw piyush" })).toBeEnabled());
    } finally {
      rejections.stop();
    }
  });
});

describe("TaskParticipants when Add member fails", () => {
  // Same contract as Withdraw: the consumer's mutation has already toasted. The
  // dialog only closes on success, so a failure must leave it open and usable.
  it.each([
    ["list", "Add member"],
    ["chips", "Add"],
  ] as const)("handles the rejection, keeps the picker open and re-enables it (%s layout)", async (layout, addLabel) => {
    const rejections = trackUnhandledRejections();
    try {
      const user = userEvent.setup();
      let fail!: (error: Error) => void;
      const onAdd = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      );
      renderParticipants({ layout, onAdd });

      await user.click(screen.getByRole("button", { name: addLabel }));
      await user.click(await screen.findByRole("button", { name: "pick a member" }));
      expect(onAdd).toHaveBeenCalledExactlyOnceWith({ userIds: ["u-new"], channelIds: ["c-new"] });
      // In flight: the picker is busy, so it cannot be submitted twice.
      expect(screen.getByRole("button", { name: "pick a member" })).toBeDisabled();

      await act(async () => fail(new Error("every participant must be an active member of your organisation")));

      expect(await rejections.unhandled()).toEqual([]);
      await waitFor(() => expect(screen.getByRole("button", { name: "pick a member" })).toBeEnabled());
    } finally {
      rejections.stop();
    }
  });
});

describe("TaskParticipants authorization", () => {
  it("never shows Withdraw to someone who is not the allocator, even an active assignee", () => {
    renderParticipants({ currentUserId: "u-ack", allocatorId: "u-boss" });
    expect(withdrawButtons()).toEqual([]);
  });

  it("lets an active assignee add a member but not a bystander (matches the server's rule)", () => {
    const { unmount } = render(
      <TaskParticipants participants={people} currentUserId="u-ack" allocatorId="u-boss" layout="list" onAdd={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Add member" })).toBeInTheDocument();
    unmount();

    render(
      <TaskParticipants participants={people} currentUserId="u-done" allocatorId="u-boss" layout="list" onAdd={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
  });

  it("renders no controls without the handlers", () => {
    renderParticipants({ onAdd: undefined, onWithdraw: undefined });
    expect(withdrawButtons()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
  });
});

describe("TaskParticipants default (chips) layout", () => {
  it("keeps the compact icon-only Withdraw and the header Add that the sticky note uses", () => {
    renderParticipants({ layout: undefined });

    expect(withdrawButtons()).toEqual(["Withdraw piyush", "Withdraw divya"]);
    expect(screen.queryByText("Withdraw")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
  });

  it("puts no Add in the participants header when the caller places it beside the title", () => {
    renderParticipants({ layout: undefined, addPlacement: "name" });
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });
});
