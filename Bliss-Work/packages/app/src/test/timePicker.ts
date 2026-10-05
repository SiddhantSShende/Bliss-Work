import { screen } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

/**
 * Drives features/TimePicker.tsx the way a real user would: open the
 * trigger, pick AM/PM, pick the hour (which auto-advances to minutes), pick
 * the minute, press OK.
 *
 * `h24` is 24-hour. `m` must land on one of the dial's twelve 5-minute
 * marks (0, 5, 10, … 55) — same as a real analog clock face.
 */
export async function setClockTime(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  h24: number,
  m: number,
) {
  await user.click(screen.getByRole("button", { name: `${label} time` }));
  const hour12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const period = h24 < 12 ? "AM" : "PM";
  await user.click(screen.getByRole("button", { name: period }));
  await user.click(screen.getByRole("button", { name: `${hour12} o'clock` }));
  await user.click(screen.getByRole("button", { name: `${String(m).padStart(2, "0")} minutes` }));
  await user.click(screen.getByRole("button", { name: "OK" }));
}
