import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MainLayout } from "./MainLayout";

describe("futuristic-call MainLayout demo", () => {
  it("renders the header, sidebar controls, stage, and chat", () => {
    render(<MainLayout />);
    expect(screen.getByText(/PROJECT AURORA - SYNC CALL/)).toBeInTheDocument();
    expect(screen.getByText("5 Participants Present")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /end call/i })).toBeInTheDocument();
    expect(screen.getByText("Aria Patel")).toBeInTheDocument();
    expect(screen.getByLabelText("Meeting chat")).toBeInTheDocument();
  });

  it("switches to the screen-share layout and keeps the bracket-framed stage", async () => {
    const user = userEvent.setup();
    render(<MainLayout />);
    await user.click(screen.getByRole("button", { name: "Screen share" }));
    expect(screen.getByText("Revenue")).toBeInTheDocument();
  });

  it("closes the chat panel from the sidebar's Chats toggle", async () => {
    const user = userEvent.setup();
    render(<MainLayout />);
    await user.click(screen.getByRole("button", { name: "Chats" }));
    expect(screen.queryByLabelText("Meeting chat")).not.toBeInTheDocument();
  });
});
