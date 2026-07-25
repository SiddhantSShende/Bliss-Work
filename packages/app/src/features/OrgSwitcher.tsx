import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { broadcastSession } from "../lib/authChannel";

/**
 * Switch the active organization. Reuses the exact login→setSession path, then
 * clears the (entirely org-scoped) query cache and lets WsEventBridge reconnect
 * the socket for the new org (it depends on user.orgId). Sibling tabs adopt via
 * broadcastSession.
 */
export function useSwitchOrg() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();
  const setSession = useSession((s) => s.setSession);
  return async (orgId: string) => {
    const s = await api.switchOrg(orgId);
    setSession({ user: s.user, accessToken: s.accessToken });
    broadcastSession(s);
    qc.clear(); // every cached query is scoped to the previous org
    nav("/app");
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
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { data: orgs = [] } = useQuery({ queryKey: qk.myOrgs, queryFn: () => api.myOrgs() });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const label = user?.orgName || orgs.find((o) => o.active)?.orgName || "Workspace";
  const canSwitch = orgs.length > 1;

  const onSelect = async (orgId: string) => {
    if (orgId === user?.orgId) {
      setOpen(false);
      return;
    }
    setBusy(orgId);
    try {
      await switchOrg(orgId);
      setOpen(false);
    } catch {
      toast.error("Couldn't switch organization", { description: "Please try again." });
    } finally {
      setBusy(null);
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
                  disabled={busy !== null}
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
                  {busy === o.orgId ? (
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
