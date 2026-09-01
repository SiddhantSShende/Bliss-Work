/**
 * The peer-to-peer file-offer bubble. This app does not download files of
 * any kind, which for the P2P transfer flow means: no Accept control in any
 * state, ever — a receiver can only Decline. Pinning that here since nothing
 * previously covered this component directly.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TransferState } from "../lib/rtcTransfer";
import { FileAttachmentBubble } from "./FileAttachmentBubble";

function renderBubble(state: TransferState, mine = false) {
  return render(
    <FileAttachmentBubble
      mine={mine}
      fileName="report.pdf"
      fileSize={2048}
      state={state}
      onDecline={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

describe("FileAttachmentBubble", () => {
  it.each<TransferState>([
    { kind: "OFFERED" },
    { kind: "CONNECTING" },
    { kind: "TRANSFERRING", progress: { bytesDone: 100, bytesTotal: 1000 } },
    { kind: "DONE" },
    { kind: "FAILED", reason: "Peer unreachable" },
  ])("never renders an Accept control in state %o, for the receiver or the sender", (state) => {
    renderBubble(state, false);
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
    renderBubble(state, true);
    expect(screen.queryByRole("button", { name: /accept/i })).not.toBeInTheDocument();
  });

  it("tells the receiver downloads are off, and offers only Decline", async () => {
    const onDecline = vi.fn();
    render(
      <FileAttachmentBubble
        mine={false}
        fileName="report.pdf"
        fileSize={2048}
        state={{ kind: "OFFERED" }}
        onDecline={onDecline}
      />,
    );

    expect(screen.getByText("File downloads are turned off.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it("gives a completed transfer no handle back to the file — no Open, no Reveal", () => {
    render(<FileAttachmentBubble mine={false} fileName="report.pdf" fileSize={2048} state={{ kind: "DONE" }} />);

    expect(screen.getByText("Transfer complete.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("never offers a Download control in any state — OFFERED itself says downloads are off", () => {
    const states: TransferState[] = [
      { kind: "OFFERED" },
      { kind: "CONNECTING" },
      { kind: "TRANSFERRING", progress: { bytesDone: 1, bytesTotal: 2 } },
      { kind: "DONE" },
      { kind: "FAILED", reason: "sha256 mismatch" },
    ];
    for (const state of states) {
      const { unmount } = renderBubble(state);
      // Not a blanket "no text contains 'download'" check — OFFERED's own
      // "File downloads are turned off." line legitimately contains the
      // word. What must never exist is a CONTROL offering one.
      expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /download/i })).not.toBeInTheDocument();
      unmount();
    }
  });
});
