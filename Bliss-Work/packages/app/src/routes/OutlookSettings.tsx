import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button, EmptyState, PageHeader, Spinner } from "@taskboard/ui";
import type { IntegrationConnectionDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useGoBack } from "../lib/useGoBack";
import { qk } from "../lib/queryKeys";
import { ConfirmDialog } from "../features/ConfirmDialog";

const OUTLOOK_PROVIDER = "outlook";

/**
 * Settings > Microsoft 365 / Outlook — connect/disconnect the one Outlook
 * mailbox a member can link to BlissWork, and see whether it's actually
 * syncing.
 *
 * The OAuth flow itself happens entirely at integrations-svc: this page only
 * asks for an authorizeUrl and redirects the browser there, then reads the
 * `?connected=outlook` / `?error=...` query params the callback redirects
 * back with (see integrations-svc/app/routes/oauth.py's `_finish`/`_app_url`).
 */
export function OutlookSettings() {
  const { t } = useTranslation(["account", "common"]);
  const { api, config } = useRuntime();
  const goBack = useGoBack();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const { data: connections, isLoading } = useQuery({
    queryKey: qk.integrations,
    queryFn: () => api.listIntegrations(),
  });
  const connection = (connections ?? []).find((c) => c.provider === OUTLOOK_PROVIDER);

  // The callback's own redirect, read once and then scrubbed from the URL so
  // a refresh doesn't re-show the same toast.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    if (!connected && !error) return;
    if (connected === OUTLOOK_PROVIDER) {
      toast.success(t("account:outlookSettings.toasts.connected"));
      void qc.invalidateQueries({ queryKey: qk.integrations });
    } else if (error) {
      const key = `account:outlookSettings.errors.${error}`;
      toast.error(
        t(key, {
          defaultValue: t("account:outlookSettings.errors.generic"),
        }),
      );
    }
    const next = new URLSearchParams(searchParams);
    next.delete("connected");
    next.delete("error");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setConnecting(true);
    try {
      const result = await api.connectIntegration(OUTLOOK_PROVIDER, {
        returnTo: config.kind === "electron" ? "desktop" : undefined,
      });
      if (result.authorizeUrl) {
        window.location.href = result.authorizeUrl;
        return; // navigating away — leave the spinner up
      }
      // Shouldn't happen for an OAuth provider, but don't strand the button.
      setConnecting(false);
    } catch {
      toast.error(t("account:outlookSettings.errors.generic"));
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!connection) return;
    setDisconnecting(true);
    try {
      await api.disconnectIntegration(connection.id);
      qc.setQueryData<IntegrationConnectionDTO[]>(qk.integrations, (prev) =>
        (prev ?? []).filter((c) => c.id !== connection.id),
      );
      toast.success(t("account:outlookSettings.toasts.disconnected"));
    } catch {
      toast.error(t("account:outlookSettings.toasts.disconnectFailed"));
    } finally {
      setDisconnecting(false);
      setConfirmDisconnect(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("account:outlookSettings.header.title")}
        subtitle={t("account:outlookSettings.header.subtitle")}
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-4">
          {isLoading ? (
            <div className="flex justify-center p-8">
              <Spinner />
            </div>
          ) : !connection ? (
            <div className="glass space-y-4 rounded-2xl p-6 text-center">
              <EmptyState
                icon={<Mail size={22} />}
                title={t("account:outlookSettings.notConnected.title")}
                hint={t("account:outlookSettings.notConnected.description")}
              />
              <Button onClick={connect} disabled={connecting}>
                {connecting ? <Spinner className="h-4 w-4 text-current" /> : t("account:outlookSettings.notConnected.connectButton")}
              </Button>
            </div>
          ) : (
            <div className="glass space-y-4 rounded-2xl p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                  <Mail size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-fg">{connection.displayLabel}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                    {connection.status === "connected" ? (
                      <>
                        <CheckCircle2 size={14} className="text-success" />
                        {t("account:outlookSettings.connected.statusLabel")}
                      </>
                    ) : (
                      <>
                        <AlertTriangle size={14} className="text-danger" />
                        {t("account:outlookSettings.connected.errorStatusLabel")}
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="text-xs text-muted">
                {connection.lastSyncedAt
                  ? t("account:outlookSettings.connected.lastSyncedAt", {
                      when: new Date(connection.lastSyncedAt).toLocaleString(),
                    })
                  : t("account:outlookSettings.connected.neverSynced")}
              </div>

              {connection.lastError && (
                <div className="rounded-lg border border-danger/30 bg-danger/10 p-2 text-xs text-danger">
                  {connection.lastError}
                </div>
              )}

              <div className="flex justify-end gap-2">
                {connection.status === "error" && (
                  <Button variant="subtle" size="sm" onClick={connect} disabled={connecting}>
                    {connecting ? <Spinner className="h-4 w-4 text-current" /> : t("account:outlookSettings.connected.reconnectButton")}
                  </Button>
                )}
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={disconnecting}
                >
                  {t("account:outlookSettings.connected.disconnectButton")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => !disconnecting && setConfirmDisconnect(false)}
        title={t("account:outlookSettings.confirmDisconnect.title")}
        message={t("account:outlookSettings.confirmDisconnect.message")}
        confirmLabel={t("account:outlookSettings.confirmDisconnect.confirmLabel")}
        danger
        busy={disconnecting}
        onConfirm={disconnect}
      />
    </div>
  );
}
