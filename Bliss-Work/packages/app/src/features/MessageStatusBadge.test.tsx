/**
 * The delivery-state badge on the sender's own bubbles.
 *
 * The rule worth holding is that the state is READABLE — it used to be one
 * versus two tick marks, which nobody could tell apart — and that an ABSENT
 * status renders nothing at all. The second one is not a nicety: channel
 * messages carry no status, and a default of "Sending…" would have stamped
 * every channel message the caller ever sent as permanently in flight.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageStatusBadge } from "./MessageStatusBadge";

describe("MessageStatusBadge", () => {
  it.each([
    ["PENDING", "Sending…"],
    ["SENT", "Sent"],
    ["DELIVERED", "Delivered"],
    ["SEEN", "Seen"],
  ] as const)("spells %s out as %s", (status, label) => {
    render(<MessageStatusBadge status={status} />);
    expect(screen.getByLabelText(label)).toHaveTextContent(label);
  });

  it("renders nothing when the surface has no delivery model", () => {
    const { container } = render(<MessageStatusBadge status={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("accents Seen and only Seen — it is the state the reader is looking for", () => {
    const { container: seen } = render(<MessageStatusBadge status="SEEN" />);
    expect(seen.querySelector(".text-accent")).not.toBeNull();

    for (const status of ["PENDING", "SENT", "DELIVERED"] as const) {
      const { container } = render(<MessageStatusBadge status={status} />);
      expect(container.querySelector(".text-accent")).toBeNull();
    }
  });
});
