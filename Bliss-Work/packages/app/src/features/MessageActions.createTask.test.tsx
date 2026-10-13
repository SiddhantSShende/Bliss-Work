/**
 * "Create task from this" — the Notes-to-Self-only entry in a message's
 * overflow menu. Absent unless the caller passes `onCreateTask`, exactly
 * like every other optional action here.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { MessageActions } from "./MessageActions";

function renderActions(onCreateTask?: () => void) {
  const containerRef = createRef<HTMLDivElement>();
  return render(
    <div ref={containerRef}>
      <MessageActions mine containerRef={containerRef} onCreateTask={onCreateTask} />
    </div>,
  );
}

describe("MessageActions: Create task from this", () => {
  it("does not render the entry when onCreateTask is omitted", async () => {
    renderActions();
    await userEvent.click(screen.getByRole("button", { name: /message actions/i }));
    expect(screen.queryByText("Create task from this")).toBeNull();
  });

  it("renders the entry and fires onCreateTask on click, closing the menu", async () => {
    const onCreateTask = vi.fn();
    renderActions(onCreateTask);
    await userEvent.click(screen.getByRole("button", { name: /message actions/i }));
    const entry = await screen.findByText("Create task from this");
    await userEvent.click(entry);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Create task from this")).toBeNull();
  });
});
