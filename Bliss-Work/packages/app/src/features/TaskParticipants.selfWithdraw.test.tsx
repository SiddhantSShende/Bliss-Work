import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskParticipantDTO } from "@taskboard/shared";
import { TaskParticipants } from "./TaskParticipants";

const person = (userId: string, username: string, status: TaskParticipantDTO["status"]) =>
  ({ userId, username, status }) as TaskParticipantDTO;

const SELF = "Withdraw from this task";
const rowOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

function renderList(props: Partial<React.ComponentProps<typeof TaskParticipants>> = {}) {
  const onWithdrawSelf = vi.fn();
  render(
    <TaskParticipants
      participants={[person("u-me", "me", "SENT"), person("u-piyush", "piyush", "ACKNOWLEDGED"), person("u-divya", "divya", "SENT")]}
      currentUserId="u-me"
      allocatorId="u-boss"
      layout="list"
      onWithdrawSelf={onWithdrawSelf}
      {...props}
    />,
  );
  return { onWithdrawSelf };
}

describe("TaskParticipants self-withdraw", () => {
  it("puts a labelled Withdraw on the viewer's own row and fires onWithdrawSelf", async () => {
    const user = userEvent.setup();
    const { onWithdrawSelf } = renderList();

    const button = within(rowOf("me")).getByRole("button", { name: SELF });
    expect(button).toHaveTextContent("Withdraw"); // visible text, not just an aria-label
    await user.click(button);

    expect(onWithdrawSelf).toHaveBeenCalledOnce();
  });

  it("offers it on the viewer's row only — other participants get no control at all", () => {
    renderList();

    expect(screen.getAllByRole("button", { name: /withdraw/i })).toHaveLength(1);
    for (const other of ["piyush", "divya"]) expect(within(rowOf(other)).queryByRole("button")).toBeNull();
  });

  it.each(["COMPLETED", "LEFT", "IGNORED"] as const)("offers nothing once the viewer's own assignment is %s", (status) => {
    renderList({ participants: [person("u-me", "me", status), person("u-piyush", "piyush", "ACKNOWLEDGED")] });

    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("offers nothing when the viewer is not on the task at all", () => {
    renderList({ currentUserId: "u-bystander" });

    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("renders no control without the handler (every other screen is unchanged)", () => {
    renderList({ onWithdrawSelf: undefined });

    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("is a list-layout control: the compact chips layout does not render it", () => {
    renderList({ layout: "chips" });

    expect(screen.queryByRole("button", { name: /withdraw/i })).toBeNull();
  });

  it("is disabled while the action is in flight, so it cannot be submitted twice", async () => {
    const user = userEvent.setup();
    const { onWithdrawSelf } = renderList({ selfWithdrawDisabled: true });

    const button = screen.getByRole("button", { name: SELF });
    expect(button).toBeDisabled();
    await user.click(button);

    expect(onWithdrawSelf).not.toHaveBeenCalled();
  });
});

describe("TaskParticipants allocator withdrawal is unchanged by self-withdraw", () => {
  const team = [person("u-boss", "boss", "ACKNOWLEDGED"), person("u-piyush", "piyush", "SENT"), person("u-divya", "divya", "ACKNOWLEDGED")];

  it("a viewer who is not the allocator never gets Withdraw-someone-else, even with both handlers", () => {
    const onWithdraw = vi.fn(async () => {});
    renderList({ onWithdraw, participants: [person("u-me", "me", "SENT"), ...team.slice(1)] });

    expect(screen.queryByRole("button", { name: "Withdraw piyush" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw divya" })).toBeNull();
    // The only control is the viewer's own.
    expect(screen.getAllByRole("button", { name: /withdraw/i }).map((b) => b.getAttribute("aria-label"))).toEqual([SELF]);
  });

  it("the allocator still withdraws others through onWithdraw, never through onWithdrawSelf", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn(async () => {});
    const onWithdrawSelf = vi.fn();
    render(
      <TaskParticipants participants={team} currentUserId="u-boss" allocatorId="u-boss" layout="list" onWithdraw={onWithdraw} onWithdrawSelf={onWithdrawSelf} />,
    );

    await user.click(screen.getByRole("button", { name: "Withdraw piyush" }));
    await user.click(screen.getByRole("button", { name: "Withdraw divya" }));

    expect(onWithdraw.mock.calls).toEqual([["u-piyush"], ["u-divya"]]);
    expect(onWithdrawSelf).not.toHaveBeenCalled();
  });

  it("an allocator who is also an open assignee gets the self control on their own row, which never calls onWithdraw", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn(async () => {});
    const onWithdrawSelf = vi.fn();
    render(
      <TaskParticipants participants={team} currentUserId="u-boss" allocatorId="u-boss" layout="list" onWithdraw={onWithdraw} onWithdrawSelf={onWithdrawSelf} />,
    );

    await user.click(within(rowOf("boss")).getByRole("button", { name: SELF }));

    expect(onWithdrawSelf).toHaveBeenCalledOnce();
    expect(onWithdraw).not.toHaveBeenCalled();
    // Exactly one button per row: nobody is offered both flavours.
    expect(screen.getAllByRole("button", { name: /withdraw/i })).toHaveLength(3);
  });

  it("without onWithdrawSelf the allocator's own row has no control, exactly as before", () => {
    render(<TaskParticipants participants={team} currentUserId="u-boss" allocatorId="u-boss" layout="list" onWithdraw={vi.fn(async () => {})} />);

    expect(within(rowOf("boss")).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Withdraw / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Withdraw piyush", "Withdraw divya"]);
  });
});

describe("TaskParticipants Withdraw labels tell the two actions apart", () => {
  const team = [person("u-boss", "boss", "ACKNOWLEDGED"), person("u-piyush", "piyush", "SENT"), person("u-divya", "divya", "ACKNOWLEDGED")];
  const visible = (b: HTMLElement) => b.textContent?.trim();
  const renderAllocator = (participants = team) =>
    render(
      <TaskParticipants participants={participants} currentUserId="u-boss" allocatorId="u-boss" layout="list" onWithdraw={vi.fn(async () => {})} onWithdrawSelf={vi.fn()} />,
    );

  it("the viewer's own row reads exactly \"Withdraw\"", () => {
    renderAllocator();

    const own = within(rowOf("boss")).getByRole("button", { name: SELF });
    expect(visible(own)).toBe("Withdraw");
  });

  it("another participant's row reads \"Withdraw <name>\" — and that visible text is its accessible name", () => {
    renderAllocator();

    for (const name of ["piyush", "divya"]) {
      const button = within(rowOf(name)).getByRole("button", { name: `Withdraw ${name}` });
      expect(visible(button)).toBe(`Withdraw ${name}`);
      expect(button).toHaveAttribute("aria-label", `Withdraw ${name}`);
    }
  });

  it("on a card with both, no two Withdraw buttons read alike", () => {
    renderAllocator();

    const labels = screen.getAllByRole("button", { name: /withdraw/i }).map(visible);
    expect(labels).toEqual(["Withdraw", "Withdraw piyush", "Withdraw divya"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("each label still drives its own action: own row -> onWithdrawSelf, other row -> onWithdraw(userId)", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn(async () => {});
    const onWithdrawSelf = vi.fn();
    render(<TaskParticipants participants={team} currentUserId="u-boss" allocatorId="u-boss" layout="list" onWithdraw={onWithdraw} onWithdrawSelf={onWithdrawSelf} />);

    await user.click(screen.getByRole("button", { name: "Withdraw piyush" }));
    expect(onWithdraw).toHaveBeenCalledExactlyOnceWith("u-piyush");
    expect(onWithdrawSelf).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: SELF }));
    expect(onWithdrawSelf).toHaveBeenCalledOnce();
    expect(onWithdraw).toHaveBeenCalledOnce();
  });

  it("a long name truncates inside the button: one shrinkable span, a protected icon, and a button capped at the card", () => {
    const long = "averyverylongusernamethatkeepsgoingandgoingforfift";
    renderAllocator([person("u-boss", "boss", "ACKNOWLEDGED"), person("u-long", long, "SENT")]);

    const button = screen.getByRole("button", { name: `Withdraw ${long}` });
    expect(button).toHaveTextContent(`Withdraw ${long}`); // the full text is in the DOM (and the accessible name) ...
    const label = within(button).getByText(`Withdraw ${long}`);
    expect(label).toHaveClass("min-w-0", "truncate"); // ... but may be cut visually, with an ellipsis, rather than overflow
    expect(button.querySelector("svg")).toHaveClass("shrink-0");
    expect(button).toHaveClass("max-w-full"); // the layout contract the card relies on
    expect(button).not.toHaveClass("shrink-0");
  });

  it("falls back to the user id when a participant has no username", () => {
    renderAllocator([person("u-boss", "boss", "ACKNOWLEDGED"), person("u-9f3", "", "SENT")]);

    expect(screen.getByRole("button", { name: "Withdraw u-9f3" })).toHaveTextContent("Withdraw u-9f3");
  });

  it("the compact chips layout is unchanged: icon-only, named only for assistive tech", () => {
    render(<TaskParticipants participants={team} currentUserId="u-boss" allocatorId="u-boss" onWithdraw={vi.fn(async () => {})} />);

    expect(screen.queryByText("Withdraw piyush")).not.toBeInTheDocument();
    expect(visible(screen.getByRole("button", { name: "Withdraw piyush" }))).toBe("");
  });
});
