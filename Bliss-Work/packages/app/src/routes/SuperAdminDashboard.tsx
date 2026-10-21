import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import { Button, Card, Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { clearSuperAdminToken, getSuperAdminToken, superAdminMe } from "../lib/superAdminAuth";

interface NavState {
  /** Set by SuperAdminLogin right after a successful POST
   *  /auth/super-admin/login — that response IS this session's
   *  authorization, issued moments ago, so this mount renders immediately
   *  instead of blocking on a redundant round-trip to re-prove it. Absent
   *  on a direct navigation or a refresh (e.g. a bookmarked URL, a reopened
   *  tab), which still block on the /me check below — there is no fresh
   *  server response to trust in that case, only whatever sits in
   *  sessionStorage, and that always gets re-verified before anything
   *  protected renders. */
  justLoggedIn?: boolean;
  email?: string;
}

/**
 * /super-admin/dashboard. Every protected link out of here still goes
 * through its OWN server-side authorization (e.g. OperatorPricing's
 * platform_operators check in billing-svc), independent of this
 * super_admin claim — removing this page's own blocking pre-check on a
 * fresh login does not weaken that; see NavState above for why.
 */
export function SuperAdminDashboard() {
  const { config } = useRuntime();
  const nav = useNavigate();
  const location = useLocation();
  const navState = location.state as NavState | null;
  const [email, setEmail] = useState<string | null>(navState?.justLoggedIn ? (navState.email ?? null) : null);
  const [checked, setChecked] = useState(Boolean(navState?.justLoggedIn));

  useEffect(() => {
    const token = getSuperAdminToken();
    if (!token) {
      nav("/super-admin/login", { replace: true });
      return;
    }
    let cancelled = false;
    void superAdminMe(config.authBase, token).then((resolvedEmail) => {
      if (cancelled) return;
      if (!resolvedEmail) {
        // Catches a fresh login's token turning out to already be invalid
        // (e.g. SUPER_ADMIN_* was reconfigured a moment later) just as
        // surely as the blocking path did — it just doesn't make the
        // ordinary case wait to find that out.
        clearSuperAdminToken();
        nav("/super-admin/login", { replace: true });
        return;
      }
      setEmail(resolvedEmail);
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [config.authBase, nav]);

  const logout = () => {
    clearSuperAdminToken();
    nav("/super-admin/login", { replace: true });
  };

  if (!checked) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 p-6">
        <div>
          <h1 className="text-lg font-semibold text-fg">Super Admin</h1>
          <p className="text-sm text-muted">Signed in as {email}</p>
        </div>
        <Button variant="subtle" onClick={logout}>
          Log out
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-3">
          <Card className="p-4">
            <h2 className="mb-1 text-sm font-semibold text-fg">Platform pricing & packages</h2>
            <p className="mb-3 text-sm text-muted">
              Manage global pricing and the credit package catalog.
            </p>
            <Link to="/operator/pricing" className="text-sm font-medium text-accent hover:underline">
              Open →
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
