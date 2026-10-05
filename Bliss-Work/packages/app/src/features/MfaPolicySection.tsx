import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { errorText } from "../lib/errorText";

/**
 * Org-admin toggle for mandatory MFA. Turning it on does NOT lock anyone out
 * immediately — it starts a grace period (MfaRequiredBanner shows a warning
 * during it); only past the deadline does an unenrolled admin's login block
 * into enrollment. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.
 */
export function MfaPolicySection() {
  const { t, i18n } = useTranslation("account");
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
          ? t("account:mfaPolicy.toasts.enabled")
          : t("account:mfaPolicy.toasts.disabled"),
      );
    },
    onError: (e) => toast.error(t("account:mfaPolicy.toasts.updateFailed"), { description: errorText(e) }),
  });

  if (isLoading || !data) return null;

  const deadline = data.mfaGracePeriodEndsAt ? new Date(data.mfaGracePeriodEndsAt) : null;

  return (
    <section className="glass flex items-center gap-4 rounded-2xl p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
        <ShieldCheck size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-fg">{t("account:mfaPolicy.title")}</div>
        <div className="mt-0.5 text-xs text-muted">
          {data.requireMfaForAdmins && deadline
            ? t("account:mfaPolicy.descriptionWithDeadline", { deadline: deadline.toLocaleDateString(i18n.language) })
            : t("account:mfaPolicy.descriptionNoDeadline")}
        </div>
      </div>
      <Button
        variant={data.requireMfaForAdmins ? "danger" : "subtle"}
        size="sm"
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(!data.requireMfaForAdmins)}
      >
        {data.requireMfaForAdmins ? t("account:mfaPolicy.turnOff") : t("account:mfaPolicy.turnOn")}
      </Button>
    </section>
  );
}
