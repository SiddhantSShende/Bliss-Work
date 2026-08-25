import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/**
 * Org-admin toggle for mandatory MFA. Turning it on does NOT lock anyone out
 * immediately — it starts a grace period (MfaRequiredBanner shows a warning
 * during it); only past the deadline does an unenrolled admin's login block
 * into enrollment. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.
 */
export function MfaPolicySection() {
  const { api } = useRuntime();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: qk.orgMfaSettings,
    queryFn: () => api.orgMfaSettings(),
  });

  const toggle = useMutation({
    mutationFn: (requireMfaForAdmins: boolean) => api.setOrgMfaSettings({ requireMfaForAdmins }),
    onSuccess: (result) => {
      qc.setQueryData(qk.orgMfaSettings, result);
      toast.success(
        result.requireMfaForAdmins
          ? "Two-factor authentication is now required for admins"
          : "Two-factor authentication is no longer required",
      );
    },
    onError: (e) => toast.error("Couldn't update the policy", { description: String(e) }),
  });

  if (isLoading || !data) return null;

  const deadline = data.mfaGracePeriodEndsAt ? new Date(data.mfaGracePeriodEndsAt) : null;

  return (
    <section className="glass flex items-center gap-4 rounded-2xl p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
        <ShieldCheck size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-fg">Require two-factor authentication for admins</div>
        <div className="mt-0.5 text-xs text-muted">
          {data.requireMfaForAdmins && deadline
            ? `Non-enrolled admins are warned until ${deadline.toLocaleDateString()}, then blocked at sign-in until they enroll.`
            : "Admins choose for themselves whether to enable it."}
        </div>
      </div>
      <Button
        variant={data.requireMfaForAdmins ? "danger" : "subtle"}
        size="sm"
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(!data.requireMfaForAdmins)}
      >
        {data.requireMfaForAdmins ? "Turn off" : "Turn on"}
      </Button>
    </section>
  );
}
