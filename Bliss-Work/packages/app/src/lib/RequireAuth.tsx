import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "../store/session";

/**
 * Route guard: bounce to /login when signed out, preserving where the
 * visitor was trying to go so they land back there after authenticating
 * (see Login.tsx / MfaChallenge.tsx, which read this `redirect` param).
 *
 * Lives in lib/ rather than App.tsx so routes/* can use it directly without
 * importing back from the top-level router module.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status);
  const location = useLocation();
  if (status !== "authed") {
    const redirect = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  return <>{children}</>;
}
