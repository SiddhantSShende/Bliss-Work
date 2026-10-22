/**
 * Settings → Credits & Billing. org_admin only — gated the same way
 * OrgActivity.tsx gates its admin-only page (client-side convenience; the
 * backend already scopes every billing-svc endpoint to the caller's own org
 * and requires org_admin for the reconcile diagnostic).
 *
 * Read-only: balance, monthly cost, reference/discounted pricing, the active
 * package catalog, and transaction history. There is no purchase/checkout
 * flow yet, so packages are shown for information only — no "Buy" button.
 */
import { useQuery } from "@tanstack/react-query";
import { CreditCard, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge, Card, EmptyState, PageHeader, Spinner, StatTile } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { useGoBack } from "../lib/useGoBack";
import { qk } from "../lib/queryKeys";
import { formatCents } from "../lib/money";

const MONTHLY_CREDIT_KEYS = { admin: "admin_monthly_credits", member: "member_monthly_credits" } as const;
const REFERENCE_PRICE_KEYS = { admin: "admin_reference_price_cents", member: "member_reference_price_cents" } as const;
const CURRENT_PRICE_KEYS = { admin: "admin_current_price_cents", member: "member_current_price_cents" } as const;

export function Billing() {
  const { t } = useTranslation(["billing", "common"]);
  const { api, config } = useRuntime();
  const goBack = useGoBack();
  const user = useSession((s) => s.user);
  const isAdmin = Boolean(user?.roles.includes("org_admin"));
  const billingConfigured = Boolean(config.billingBase);

  const balanceQ = useQuery({
    queryKey: qk.billingBalance,
    queryFn: () => api.billingBalance(),
    enabled: isAdmin && billingConfigured,
  });
  const ledgerQ = useQuery({
    queryKey: qk.billingLedger,
    queryFn: () => api.billingLedger({ limit: 50 }),
    enabled: isAdmin && billingConfigured,
  });
  const packagesQ = useQuery({
    queryKey: qk.billingPackages,
    queryFn: () => api.billingPackages(),
    enabled: isAdmin && billingConfigured,
  });
  const pricingQ = useQuery({
    queryKey: qk.billingPricing,
    queryFn: () => api.billingPricing(),
    enabled: isAdmin && billingConfigured,
  });

  if (!isAdmin) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<CreditCard size={24} />}
          title={t("billing:org.adminsOnly.title")}
          hint={t("billing:org.adminsOnly.hint")}
        />
      </div>
    );
  }

  const pricingValue = (key: string): number | undefined => {
    const row = pricingQ.data?.find((p) => p.key === key);
    return typeof row?.value === "number" ? row.value : undefined;
  };

  const isLoading = balanceQ.isLoading || ledgerQ.isLoading || packagesQ.isLoading || pricingQ.isLoading;
  const hasError = balanceQ.isError || ledgerQ.isError || packagesQ.isError || pricingQ.isError;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("billing:org.header.title")} subtitle={t("billing:org.header.subtitle")} onBack={goBack} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-5">
          {!billingConfigured ? (
            <EmptyState
              icon={<CreditCard size={24} />}
              title={t("billing:org.freemium.title")}
              hint={t("billing:org.freemium.hint")}
            />
          ) : isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner />
              <span className="ml-2 text-sm text-muted">{t("billing:org.states.loading")}</span>
            </div>
          ) : hasError ? (
            <EmptyState icon={<AlertTriangle size={24} />} title={t("billing:org.states.error")} />
          ) : (
            <>
              {balanceQ.data && balanceQ.data.balance <= 0 && (
                <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-fg">
                  <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
                  <div>
                    <div className="font-semibold">{t("billing:org.insufficientBanner.title")}</div>
                    <div className="text-muted">{t("billing:org.insufficientBanner.description")}</div>
                  </div>
                </div>
              )}

              <StatTile
                label={t("billing:org.balance.label")}
                value={t("billing:org.balance.credits", { count: balanceQ.data?.balance ?? 0 })}
              />

              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-fg">{t("billing:org.monthlyCost.title")}</h2>
                <div className="grid grid-cols-2 gap-3">
                  <MonthlyCostRow
                    label={t("billing:org.monthlyCost.admin")}
                    credits={pricingValue(MONTHLY_CREDIT_KEYS.admin)}
                    referenceCents={pricingValue(REFERENCE_PRICE_KEYS.admin)}
                    currentCents={pricingValue(CURRENT_PRICE_KEYS.admin)}
                    t={t}
                  />
                  <MonthlyCostRow
                    label={t("billing:org.monthlyCost.member")}
                    credits={pricingValue(MONTHLY_CREDIT_KEYS.member)}
                    referenceCents={pricingValue(REFERENCE_PRICE_KEYS.member)}
                    currentCents={pricingValue(CURRENT_PRICE_KEYS.member)}
                    t={t}
                  />
                </div>
              </Card>

              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-fg">{t("billing:org.packages.title")}</h2>
                {packagesQ.data && packagesQ.data.length > 0 ? (
                  <ul className="space-y-2">
                    {packagesQ.data.map((p) => (
                      <li key={p.id} className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2 text-sm">
                        <span className="font-medium text-fg">{p.name}</span>
                        <span className="text-muted">
                          {t("billing:org.packages.creditsLabel", { count: p.credits })} · {formatCents(p.priceCents, p.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">{t("billing:org.packages.empty")}</p>
                )}
              </Card>

              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-fg">{t("billing:org.ledger.title")}</h2>
                {ledgerQ.data && ledgerQ.data.length > 0 ? (
                  <ul className="space-y-1.5">
                    {ledgerQ.data.map((entry) => (
                      <li key={entry.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm">
                        <div className="min-w-0">
                          <div className="truncate text-fg">{t(`billing:org.ledger.reasons.${entry.reason}`, { defaultValue: entry.reason })}</div>
                          <div className="text-xs text-muted">{new Date(entry.createdAt).toLocaleString()}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge className={entry.delta >= 0 ? "bg-emerald-500/15 text-emerald-600" : "bg-red-500/15 text-red-600"}>
                            {entry.delta >= 0 ? "+" : ""}
                            {entry.delta}
                          </Badge>
                          <span className="tabular-nums text-muted">{entry.balanceAfter}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">{t("billing:org.ledger.empty")}</p>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MonthlyCostRow({
  label,
  credits,
  referenceCents,
  currentCents,
  t,
}: {
  label: string;
  credits?: number;
  referenceCents?: number;
  currentCents?: number;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-fg">
        {credits !== undefined ? t("billing:org.monthlyCost.creditsPerMonth", { count: credits }) : "—"}
      </div>
      {referenceCents !== undefined && currentCents !== undefined && (
        <div className="mt-1 text-xs text-muted">
          <span className="line-through">{formatCents(referenceCents)}</span>{" "}
          <span className="font-medium text-fg">{formatCents(currentCents)}</span>
        </div>
      )}
    </div>
  );
}
