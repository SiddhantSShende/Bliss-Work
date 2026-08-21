/**
 * The chat header's single call control.
 *
 * The rule this file exists to hold is a COUNT: one trigger, four options. Both
 * halves are easy to break by adding "just one more" — a second icon beside it,
 * or a fifth row in the menu — and neither would fail anything else.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CallMenu } from "./CallMenu";

function menu(props: Partial<Parameters<typeof CallMenu>[0]> = {}) {
  const handlers = {
    onVoiceCall: vi.fn(),
    onVideoCall: vi.fn(),
    onSendLink: vi.fn(),
    onSchedule: vi.fn(),
  };
  render(<CallMenu {...handlers} {...props} />);
  return handlers;
}

describe("CallMenu", () => {
  it("is one control until it is opened", () => {
    menu();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Call" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens exactly four options, in the order they are offered", async () => {
    const user = userEvent.setup();
    menu();
    await user.click(screen.getByRole("button", { name: "Call" }));

    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.textContent)).toEqual([
      "Voice Call",
      "Video Call",
      "Send Call Link",
      "Schedule Call",
    ]);
  });

  it("gives every option its own icon", async () => {
    const user = userEvent.setup();
    menu();
    await user.click(screen.getByRole("button", { name: "Call" }));

    // lucide stamps the icon's name into the class list, so the RIGHT icon is
    // checkable — not merely the presence of some svg.
    const icons = screen.getAllByRole("menuitem").map((i) => i.querySelector("svg")?.getAttribute("class") ?? "");
    expect(icons).toHaveLength(4);
    expect(icons[0]).toMatch(/phone/i);
    expect(icons[1]).toMatch(/video/i);
    expect(icons[2]).toMatch(/link/i);
    expect(icons[3]).toMatch(/calendar/i);
  });

  it("routes each option to its own handler, and closes behind it", async () => {
    const user = userEvent.setup();
    const h = menu();

    for (const [label, handler] of [
      ["Voice Call", h.onVoiceCall],
      ["Video Call", h.onVideoCall],
      ["Send Call Link", h.onSendLink],
      ["Schedule Call", h.onSchedule],
    ] as const) {
      await user.click(screen.getByRole("button", { name: "Call" }));
      await user.click(screen.getByRole("menuitem", { name: label }));
      expect(handler).toHaveBeenCalledOnce();
      // Every one of the four either navigates, opens a dialog or fires a
      // request — none of them wants the panel left behind.
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    }
  });

  it("disables only Send Call Link while a link is being minted", async () => {
    const user = userEvent.setup();
    menu({ busy: true });
    await user.click(screen.getByRole("button", { name: "Call" }));

    expect(screen.getByRole("menuitem", { name: "Send Call Link" })).toBeDisabled();
    for (const other of ["Voice Call", "Video Call", "Schedule Call"]) {
      expect(screen.getByRole("menuitem", { name: other })).toBeEnabled();
    }
  });

  // Asserted through the BEHAVIOUR — click somewhere else, menu goes away —
  // rather than through the click-away backdrop that used to implement it. The
  // backdrop is gone (it covered the whole app and ate the click that dismissed
  // it, so reaching any other control took two presses); this rule did not
  // change, and a test written against the mechanism rather than the rule is
  // what turned removing that layer into a false failure.
  it("closes when the click lands outside it", async () => {
    const user = userEvent.setup();
    menu();
    await user.click(screen.getByRole("button", { name: "Call" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    menu();
    await user.click(screen.getByRole("button", { name: "Call" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
