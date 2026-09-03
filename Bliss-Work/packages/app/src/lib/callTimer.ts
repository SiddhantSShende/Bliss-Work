import { useEffect, useState } from "react";

/**
 * How long a call has been running, as a clock.
 *
 * `m:ss` under an hour and `h:mm:ss` over it — the same shape every phone uses,
 * and the reason the minutes are not zero-padded in the short form: "7:04" is a
 * duration, "07:04" reads as a time of day.
 */
function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * A ticking duration since `startedAt` (epoch ms), or "" before the call
 * connects.
 *
 * Re-renders once a second and no more: the interval is torn down whenever
 * there is nothing to count, so an idle overlay is not a timer running behind
 * the app for the rest of the session.
 */
export function useCallDuration(startedAt?: number): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return startedAt ? formatCallDuration(now - startedAt) : "";
}
