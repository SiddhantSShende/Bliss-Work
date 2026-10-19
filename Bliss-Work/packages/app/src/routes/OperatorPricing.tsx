/**
 * /operator/pricing — platform-operator-only pricing & package management.
 *
 * Deliberately NOT an org-admin settings control, and deliberately NOT
 * linked from any nav: there is no client-side signal of "is this user a
 * platform operator" (operator status lives only in billing-svc's
 * platform_operators table, independent of any org's roles), so this page
 * cannot gate itself on a role the client can see. It renders its editing
 * controls for any authenticated user who navigates here directly — the
 * backend is what actually enforces operator-only writes, rejecting every
 * one with 403 for anyone else. That is the explicit design: "do not rely
 * on hiding UI controls for security."
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, EmptyState, Input, PageHeader, Spinner } from "@taskboard/ui";
import { ApiError, type BillingPackageDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useGoBack } from "../lib/useGoBack";
import { qk } from "../lib/queryKeys";

const PRICING_KEYS = [
  "admin_monthly_credits",
  "member_monthly_credits",
  "admin_reference_price_cents",
  "member_reference_price_cents",
  "admin_current_price_cents",
  "member_current_price_cents",
] as const;

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

export function OperatorPricing() {
  const { t } = useTranslation(["billing", "common"]);
  const { api, config } = useRuntime();
  const goBack = useGoBack();
  const qc = useQueryClient();
  const billingConfigured = Boolean(config.billingBase);

  const pricingQ = useQuery({
    queryKey: qk.billingPricing,
    queryFn: () => api.billingPricing(),
    enabled: billingConfigured,
  });
  const packagesAllQ = useQuery({
    queryKey: qk.billingPackages,
    queryFn: () => api.billingPackages(),
    enabled: billingConfigured,
  });

  const updatePricing = useMutation({
    mutationFn: ({ key, value }: { key: string; value: number }) => api.billingUpdatePricing(key, value),
    onSuccess: () => {
      toast.success(t("billing:operator.pricing.saved"));
      qc.invalidateQueries({ queryKey: qk.billingPricing });
    },
    onError: (err) => {
      toast.error(isForbidden(err) ? t("billing:operator.pricing.saveFailedForbidden") : t("billing:operator.pricing.saveFailed"));
    },
  });

  const createPackage = useMutation({
    mutationFn: (body: { name: string; credits: number; priceCents: number }) => api.billingCreatePackage(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.billingPackages });
    },
    onError: (err) => {
      toast.error(isForbidden(err) ? t("billing:operator.packages.createFailedForbidden") : t("billing:operator.packages.createFailed"));
    },
  });

  const updatePackage = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<BillingPackageDTO, "name" | "credits" | "priceCents" | "active">> }) =>
      api.billingUpdatePackage(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.billingPackages });
    },
    onError: (err) => {
      toast.error(isForbidden(err) ? t("billing:operator.packages.updateFailedForbidden") : t("billing:operator.packages.updateFailed"));
    },
  });

  const isLoading = pricingQ.isLoading || packagesAllQ.isLoading;
  const hasError = pricingQ.isError || packagesAllQ.isError;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("billing:operator.header.title")} subtitle={t("billing:operator.header.subtitle")} onBack={goBack} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-5">
          <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-surface-2 p-3 text-sm">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-muted" />
            <div>
              <div className="font-semibold text-fg">{t("billing:operator.forbiddenBanner.title")}</div>
              <div className="text-muted">{t("billing:operator.forbiddenBanner.description")}</div>
            </div>
          </div>

          {!billingConfigured ? (
            <EmptyState icon={<AlertTriangle size={24} />} title={t("billing:org.unavailable.title")} hint={t("billing:org.unavailable.hint")} />
          ) : isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner />
              <span className="ml-2 text-sm text-muted">{t("billing:operator.states.loading")}</span>
            </div>
          ) : hasError ? (
            <EmptyState icon={<AlertTriangle size={24} />} title={t("billing:operator.states.error")} />
          ) : (
            <>
              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-fg">{t("billing:operator.pricing.title")}</h2>
                <div className="space-y-2">
                  {PRICING_KEYS.map((key) => {
                    const row = pricingQ.data?.find((p) => p.key === key);
                    const current = typeof row?.value === "number" ? row.value : "";
                    return (
                      <PricingRow
                        key={key}
                        label={t(`billing:operator.pricing.keys.${key}`)}
                        initialValue={current}
                        saving={updatePricing.isPending}
                        onSave={(value) => updatePricing.mutate({ key, value })}
                        saveLabel={t("billing:operator.pricing.save")}
                      />
                    );
                  })}
                </div>
              </Card>

              <Card className="p-4">
                <h2 className="mb-3 text-sm font-semibold text-fg">{t("billing:operator.packages.title")}</h2>
                {packagesAllQ.data && packagesAllQ.data.length > 0 ? (
                  <ul className="mb-4 space-y-2">
                    {packagesAllQ.data.map((pkg) => (
                      <PackageRow
                        key={pkg.id}
                        pkg={pkg}
                        saving={updatePackage.isPending}
                        onToggleActive={() => updatePackage.mutate({ id: pkg.id, body: { active: !pkg.active } })}
                        onSave={(body) => updatePackage.mutate({ id: pkg.id, body })}
                        t={t}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="mb-4 text-sm text-muted">{t("billing:operator.packages.empty")}</p>
                )}
                <NewPackageForm
                  creating={createPackage.isPending}
                  onCreate={(body) => createPackage.mutate(body)}
                  t={t}
                />
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PricingRow({
  label,
  initialValue,
  saving,
  onSave,
  saveLabel,
}: {
  label: string;
  initialValue: number | "";
  saving: boolean;
  onSave: (value: number) => void;
  saveLabel: string;
}) {
  const [value, setValue] = useState<string>(String(initialValue));
  return (
    <div className="flex items-center gap-2">
      <span className="flex-1 text-sm text-fg">{label}</span>
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-9 w-28"
      />
      <Button
        size="sm"
        variant="subtle"
        disabled={saving || value === ""}
        onClick={() => onSave(Number(value))}
      >
        {saveLabel}
      </Button>
    </div>
  );
}

function PackageRow({
  pkg,
  saving,
  onToggleActive,
  onSave,
  t,
}: {
  pkg: BillingPackageDTO;
  saving: boolean;
  onToggleActive: () => void;
  onSave: (body: { name: string; credits: number; priceCents: number }) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [name, setName] = useState(pkg.name);
  const [credits, setCredits] = useState(String(pkg.credits));
  const [priceCents, setPriceCents] = useState(String(pkg.priceCents));

  return (
    <li className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 flex-1" />
        <Badge className={pkg.active ? "bg-emerald-500/15 text-emerald-600" : "bg-muted/20 text-muted"}>
          {pkg.active ? t("billing:operator.packages.active") : t("billing:operator.packages.inactive")}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <Input type="number" value={credits} onChange={(e) => setCredits(e.target.value)} className="h-9 w-28" />
        <Input type="number" value={priceCents} onChange={(e) => setPriceCents(e.target.value)} className="h-9 w-32" />
        <Button
          size="sm"
          variant="subtle"
          disabled={saving}
          onClick={() => onSave({ name, credits: Number(credits), priceCents: Number(priceCents) })}
        >
          {t("billing:operator.packages.save")}
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={onToggleActive}>
          {pkg.active ? t("billing:operator.packages.deactivate") : t("billing:operator.packages.activate")}
        </Button>
      </div>
    </li>
  );
}

function NewPackageForm({
  creating,
  onCreate,
  t,
}: {
  creating: boolean;
  onCreate: (body: { name: string; credits: number; priceCents: number }) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [name, setName] = useState("");
  const [credits, setCredits] = useState("");
  const [priceCents, setPriceCents] = useState("");
  const canCreate = name.trim().length > 0 && Number(credits) > 0 && Number(priceCents) >= 0;

  return (
    <div className="flex items-center gap-2 border-t border-border/60 pt-3">
      <Input placeholder={t("billing:operator.packages.name")} value={name} onChange={(e) => setName(e.target.value)} className="h-9 flex-1" />
      <Input
        type="number"
        placeholder={t("billing:operator.packages.credits")}
        value={credits}
        onChange={(e) => setCredits(e.target.value)}
        className="h-9 w-28"
      />
      <Input
        type="number"
        placeholder={t("billing:operator.packages.price")}
        value={priceCents}
        onChange={(e) => setPriceCents(e.target.value)}
        className="h-9 w-32"
      />
      <Button
        size="sm"
        disabled={!canCreate || creating}
        onClick={() => {
          onCreate({ name: name.trim(), credits: Number(credits), priceCents: Number(priceCents) });
          setName("");
          setCredits("");
          setPriceCents("");
        }}
      >
        <Plus size={14} className="mr-1" />
        {t("billing:operator.packages.create")}
      </Button>
    </div>
  );
}
