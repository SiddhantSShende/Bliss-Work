/**
 * The geometry behind the clock-face time picker (`ClockTimePicker.tsx`), kept
 * free of React so it can be tested. Angles are degrees CLOCKWISE from 12
 * o'clock, 0 <= a < 360 — the same direction the hands of a clock move.
 */

/** A touch at (dx, dy) from the dial's centre (screen y grows DOWNWARD) -> angle. */
export function pointToAngle(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** The hour 1-12 nearest an angle (30 degrees per hour; 12 sits at the top). */
export function angleToHour(angle: number): number {
  const h = Math.round((((angle % 360) + 360) % 360) / 30) % 12;
  return h === 0 ? 12 : h;
}

/** The minute 0-59 nearest an angle (6 degrees per minute). */
export function angleToMinute(angle: number): number {
  return Math.round((((angle % 360) + 360) % 360) / 6) % 60;
}

export function hourToAngle(hour: number): number {
  return (hour % 12) * 30;
}

export function minuteToAngle(minute: number): number {
  return (minute % 60) * 6;
}

/** Where a point at `angle`, `radius` away from the centre sits (offsets from the centre, y downward). */
export function polar(angle: number, radius: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: radius * Math.sin(rad), y: -radius * Math.cos(rad) };
}
