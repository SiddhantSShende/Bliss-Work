/**
 * Organizations section — switch between the workspaces this identity belongs to
 * (one email/password can span multiple orgs), and jump to managing the current
 * one (members, invites). The active org is also switchable from the top bar.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Building2, Check, Users, UserPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button, PageHeader } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useSwitchOrg } from "../features/OrgSwitcher";
import { useGoBack } from "../lib/useGoBack";

export function Org() {
  const { api } = useRuntime();
  const nav = useNavigate();
  const goBack = useGoBack();
  const user = useSession((s) => s.user);
  const switchOrg = useSwitchOrg();
  const [busy, setBusy] = useState<string | null>(null);

  const { data: orgs = [], isLoading } = useQuery({ queryKey: qk.myOrgs, queryFn: () => api.myOrgs() });

  const doSwitch = async (orgId: string) => {
    if (orgId === user?.orgId) return;
    setBusy(orgId);
    try {
      await switchOrg(orgId);
      toast.success("Switched organization");
    } catch {
      toast.error("Couldn't switch organization", { description: "Please try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Organizations"
        subtitle="Switch between the workspaces you belong to, or manage the current one."
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-6">
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
              <Building2 size={16} className="text-accent" /> Your organizations
            </h2>
            {isLoading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted">
                <Loader2 size={14} className="animate-spin" /> Loading…
              </div>
            ) : (
              <div className="space-y-2">
                {orgs.map((o) => {
                  const active = o.orgId === user?.orgId;
                  return (
                    <div key={o.orgId} className="glass flex items-center gap-3 rounded-2xl p-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                        <Building2 size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                          {o.orgName}
                          {active && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
                              <Check size={10} /> Current
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-muted">
                          {o.roles.includes("org_admin") ? "Admin" : "Member"}
                        </div>
                      </div>
                      {active ? (
                        <span className="text-xs text-muted">Active</span>
                      ) : (
                        <Button
                          variant="subtle"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => doSwitch(o.orgId)}
                        >
                          {busy === o.orgId ? "Switching…" : "Switch"}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-fg">
              Manage {user?.orgName || "this organization"}
            </h2>
            <div className="flex flex-wrap gap-2">
              <Button variant="subtle" size="sm" onClick={() => nav("/app/members")}>
                <Users size={15} /> Members
              </Button>
              <Button variant="subtle" size="sm" onClick={() => nav("/app/invite")}>
                <UserPlus size={15} /> Invite people
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
