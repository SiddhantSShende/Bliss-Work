import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Opens every My tasks card's Details panel (participants, timelines, reviews). */
export async function expandAllDetails() {
  const user = userEvent.setup();
  for (const toggle of screen.queryAllByRole("button", { name: "Details", expanded: false })) await user.click(toggle);
}
