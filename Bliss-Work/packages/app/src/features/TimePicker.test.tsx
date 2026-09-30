/**
 * The round/analog clock that replaced the native time input: opening it,
 * picking hour then minute then OK commits; Cancel or a click outside
 * discards the draft and leaves the field exactly as it was.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimePicker } from "./TimePicker";

function renderPicker(value = "14:30") {
  const onChange = vi.fn();
  render(
    <div>
      <TimePicker label="Start Time" value={value} onChange={onChange} />
      <button type="button">Outside</button>
    </div>,
  );
  return { onChange, user: userEvent.setup() };
}

describe("TimePicker", () => {
  it("shows the value, locale-formatted, on the closed trigger", () => {
    renderPicker("14:30");
    expect(screen.getByRole("button", { name: "Start Time time" })).toHaveTextContent("2:30 PM");
  });

  it("opens on click, hour first", async () => {
    const { user } = renderPicker("14:30");
    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    expect(screen.getByRole("button", { name: "2 o'clock" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "30 minutes" })).not.toBeInTheDocument();
  });

  it("picking an hour advances to minutes", async () => {
    const { user } = renderPicker("14:30");
    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    await user.click(screen.getByRole("button", { name: "5 o'clock" }));
    expect(screen.queryByRole("button", { name: "2 o'clock" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30 minutes" })).toBeInTheDocument();
  });

  it("commits hour + minute + AM/PM on OK, and closes", async () => {
    const { user, onChange } = renderPicker("14:30");
    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    await user.click(screen.getByRole("button", { name: "AM" }));
    await user.click(screen.getByRole("button", { name: "9 o'clock" }));
    await user.click(screen.getByRole("button", { name: "15 minutes" }));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onChange).toHaveBeenCalledWith("09:15");
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
  });

  it("PM rolls the hour into 24-hour time", async () => {
    const { user, onChange } = renderPicker("09:00");
    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    await user.click(screen.getByRole("button", { name: "PM" }));
    await user.click(screen.getByRole("button", { name: "9 o'clock" }));
    await user.click(screen.getByRole("button", { name: "00 minutes" }));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onChange).toHaveBeenCalledWith("21:00");
  });

  it("12 AM and 12 PM are midnight and noon", async () => {
    const { user, onChange } = renderPicker("09:00");
    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    await user.click(screen.getByRole("button", { name: "AM" }));
    await user.click(screen.getByRole("button", { name: "12 o'clock" }));
    await user.click(screen.getByRole("button", { name: "00 minutes" }));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onChange).toHaveBeenCalledWith("00:00");
  });

  it("Cancel discards the draft and leaves the value untouched", async () => {
    const { user, onChange } = renderPicker("14:30");
    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    await user.click(screen.getByRole("button", { name: "9 o'clock" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start Time time" })).toHaveTextContent("2:30 PM");
  });

  it("a click outside the popover discards the draft the same way Cancel does", async () => {
    const { user, onChange } = renderPicker("14:30");
    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    await user.click(screen.getByRole("button", { name: "9 o'clock" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
  });

  it("reopening starts back at the field's current value, not the last draft", async () => {
    const { user, onChange } = renderPicker("14:30");
    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    await user.click(screen.getByRole("button", { name: "9 o'clock" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Start Time time" }));
    expect(screen.getByRole("button", { name: "2 o'clock" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
