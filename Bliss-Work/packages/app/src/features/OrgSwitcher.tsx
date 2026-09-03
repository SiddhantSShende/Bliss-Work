import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { create } from "zustand";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { isMfaPending } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { broadcastSession } from "../lib/authChannel";
import { usePopupDismiss } from "../lib/usePopupDismiss";

/** What a switch attempt actually did. A non-throwing resolution is NOT
 *  enough on its own to mean "switched" — it is also what a redirect to
 *  /mfa-challenge and a request another caller superseded look like.
 *  Callers must branch on this rather than assume completion. */
export type SwitchOrgOutcome = "switched" | "mfaPending" | "superseded";

interface OrgSwitchStore {
  /** orgId of the switch currently in flight, shared across every caller of
   *  useSwitchOrg — the top-bar switcher, the Organizations page, and the
   *  leave-org fallback switch all share this one lock instead of each
   *  tracking its own, independent `busy` flag. */
  busyOrgId: string | null;
}
const useOrgSwitchStore = create<OrgSwitchStore>(() => ({ busyOrgId: null }));

/** The org a switch is currently in flight for, or null — read by any
 *  component offering a "Switch" action so a switch started elsewhere (top
 *  bar vs. the Organizations page) disables this one too. */
export function useOrgSwitchBusyId(): string | null {
  return useOrgSwitchStore((s) => s.busyOrgId);
}

// Bumped on every call; a response is only applied if it is still the most
// recently requested one. Without this, a slow switch resolving after a
// faster, later one would clobber the session/navigation the later one
// already applied — the same "stale response after a newer request" hazard
// MeetingHost.tsx guards against for join requests, with the same fix: tag
// each attempt and drop any whose tag has been superseded by the time it
// resolves.
let switchSeq = 0;

/**
 * Switch the active organization. Reuses the exact login→setSession path, then
 * clears the (entirely org-scoped) query cache and lets WsEventBridge reconnect
 * the socket for the new org (it depends on user.orgId). Sibling tabs adopt via
 * broadcastSession.
 *
 * The target membership can itself require a second factor — its own policy,
 * evaluated independently of the org being left (see
 * docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7) — in which case the CURRENT
 * session is left untouched (the switch never happened) and the caller is
 * routed through the same /mfa-challenge page a fresh login uses.
 *
 * Only one switch is ever in flight at a time, no matter which component
 * started it (see `useOrgSwitchBusyId`), and callers must inspect the
 * returned `SwitchOrgOutcome` rather than assume a non-throwing call means
 * the switch completed.
 */
export function useSwitchOrg() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();
  const setSession = useSession((s) => s.setSession);
  return async (orgId: string): Promise<SwitchOrgOutcome> => {
    const seq = ++switchSeq;
    useOrgSwitchStore.setState({ busyOrgId: orgId });
    try {
      const result = await api.switchOrg(orgId);
      // A newer switch — from this caller or a different one entirely — was
      // requested before this response came back. That one is authoritative
      // now; applying this stale one on top of it would clobber it.
      if (seq !== switchSeq) return "superseded";
      if (isMfaPending(result)) {
        nav("/mfa-challenge", { state: result });
        return "mfaPending";
      }
      setSession({ user: result.user, accessToken: result.accessToken, expiresIn: result.expiresIn });
      broadcastSession(result);
      qc.clear(); // every cached query is scoped to the previous org
      nav("/app");
      return "switched";
    } finally {
      if (seq === switchSeq) useOrgSwitchStore.setState({ busyOrgId: null });
    }
  };
}

/** Workspace switcher shown in the top bar: current org + a dropdown of the
 *  organizations this identity belongs to. Renders even with one org (shows the
 *  name); the dropdown only offers a switch when there are 2+. */
export function OrgSwitcher() {
  const { api } = useRuntime();
  const user = useSession((s) => s.user);
  const switchOrg = useSwitchOrg();
  const [open, setOpen] = useState(false);
  const busyOrgId = useOrgSwitchBusyId();
  const ref = usePopupDismiss<HTMLDivElement>(open, () => setOpen(false));

  const { data: orgs = [] } = useQuery({ queryKey: qk.myOrgs, queryFn: () => api.myOrgs() });

  const label = user?.orgName || orgs.find((o) => o.active)?.orgName || "Workspace";
  const canSwitch = orgs.length > 1;

  const onSelect = async (orgId: string) => {
    if (orgId === user?.orgId) {
      setOpen(false);
      return;
    }
    try {
      const outcome = await switchOrg(orgId);
      // A superseded attempt leaves whatever the newer switch is doing
      // alone — closing the dropdown here could yank focus from under it.
      if (outcome !== "superseded") setOpen(false);
    } catch {
      toast.error("Couldn't switch organization", { description: "Please try again." });
    }
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => canSwitch && setOpen((o) => !o)}
        title={canSwitch ? "Switch organization" : label}
        className={`flex items-center gap-1.5 rounded-xl border border-border/70 bg-surface/60 px-2.5 py-1.5 text-sm font-medium text-fg transition-colors ${
          canSwitch ? "hover:bg-surface-2" : "cursor-default"
        }`}
      >
        <Building2 size={15} className="shrink-0 text-accent" />
        <span className="max-w-[9rem] truncate">{label}</span>
        {canSwitch && <ChevronsUpDown size={13} className="shrink-0 text-muted" />}
      </button>
      {open && canSwitch && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Your organizations
          </div>
          <div className="max-h-72 overflow-auto pb-1">
            {orgs.map((o) => {
              const active = o.orgId === user?.orgId;
              return (
                <button
                  key={o.orgId}
                  disabled={busyOrgId !== null}
                  onClick={() => onSelect(o.orgId)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 disabled:opacity-50"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    <Building2 size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-fg">{o.orgName}</div>
                    <div className="truncate text-[11px] text-muted">
                      {o.roles.includes("org_admin") ? "Admin" : "Member"}
                    </div>
                  </div>
                  {busyOrgId === o.orgId ? (
                    <span className="text-[11px] text-muted">Switching…</span>
                  ) : (
                    active && <Check size={15} className="shrink-0 text-accent" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
