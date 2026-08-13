import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * "Back to wherever I came from", with a safety net.
 *
 * `nav(-1)` on its own is wrong for a first-load deep link: there is nothing
 * behind that entry, so the browser leaves the app entirely — and in the
 * desktop shell it lands on a blank window with no way out. React Router marks
 * the first entry of a session with `location.key === "default"`, which is
 * precisely the case that needs `fallback` instead.
 */
export function useGoBack(fallback = "/app/inbox") {
  const nav = useNavigate();
  const { key } = useLocation();
  return useCallback(() => {
    if (key === "default") nav(fallback);
    else nav(-1);
  }, [key, nav, fallback]);
}
