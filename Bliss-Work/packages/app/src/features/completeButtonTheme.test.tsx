/**
 * The Complete action follows the theme's accent instead of a hardcoded green.
 *
 * jsdom does not resolve Tailwind, so what can be pinned is which tokens the
 * button is built from: the brand-gradient utilities and `text-accent-fg` are
 * CSS variables that ThemeProvider rewrites when the theme changes (a preset
 * switches the variables through its class; the custom theme sets them
 * inline), so a button built from them retargets with no re-render of its
 * own. A hardcoded `bg-success` does not — it is green in every theme.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { StickyTaskDTO } from "@taskboard/shared";
import { StickyWidget } from "./StickyWidget";

const task: StickyTaskDTO = {
  taskId: "6f1c1c0e-6a52-4d54-9d0b-3f6a3d3a7f11",
  orgId: "5b7f2a4e-7c26-4a35-8f0d-0e6f0a6f9c22",
  title: "Ship the release",
  description: "",
  senderId: "0d0c1c0e-6a52-4d54-9d0b-3f6a3d3a7f11",
  senderUsername: "sam",
  myStatus: "ACKNOWLEDGED",
  actions: ["COMPLETE", "LEAVE"],
  statusVersion: 1,
  assignedAt: "2026-09-01T00:00:00Z",
  acknowledgedAt: "2026-09-01T00:01:00Z",
  reviewRating: null,
  participants: [],
};

describe("Complete button", () => {
  it("is built from the accent tokens, not the fixed success green", () => {
    render(<StickyWidget task={task} onAction={vi.fn()} />);
    const complete = screen.getByRole("button", { name: /complete/i });
    expect(complete).toHaveClass("from-brand-from", "to-brand-to", "text-accent-fg");
    expect(complete.className).not.toMatch(/success|green|emerald|text-white/);
  });

  it("matches the Acknowledge button it replaces in the flow (same tokens)", () => {
    render(<StickyWidget task={{ ...task, myStatus: "SENT", actions: ["ACKNOWLEDGE", "IGNORE"] }} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: /acknowledge/i })).toHaveClass("from-brand-from", "to-brand-to", "text-accent-fg");
  });

  it("shows Add member for an active assigned card even when its participant array is empty", () => {
    render(
      <StickyWidget
        task={task}
        onAction={vi.fn()}
        currentUserId="assignee"
        participantLayout="list"
        onAddParticipants={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByRole("button", { name: "Add member" })).toBeInTheDocument();
  });

  it("does not show Add member for a completed assigned card", () => {
    render(
      <StickyWidget
        task={{ ...task, myStatus: "COMPLETED" }}
        onAction={vi.fn()}
        currentUserId="assignee"
        participantLayout="list"
        onAddParticipants={vi.fn(async () => {})}
      />,
    );

    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
  });
});
