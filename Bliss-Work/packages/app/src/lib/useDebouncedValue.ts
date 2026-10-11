import { useEffect, useState } from "react";

/** `value`, but only after it has stopped changing for `ms` — so typing in a search box
 *  asks the server once, for what was typed, not once per keystroke. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
