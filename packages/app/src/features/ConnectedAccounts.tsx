/**
 * Connected accounts — connect/disconnect external platforms.
 *
 * Credentials are sent to integrations-svc and stored ENCRYPTED at rest; tokens
 * are never returned to the client. Token-paste providers (Slack, WhatsApp)
 * collect their credentials in a dialog; OAuth providers (Gmail, Outlook,
 * Teams) redirect through the provider's consent screen.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Mail, MessageCircle, Plug, Slack, Users } from "lucide-react";
import { toast } from "sonner";
import { Button, Input } from "@taskboard/ui";
import type { IntegrationConnectionDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { Modal } from "./Modal";

type ProviderKind = "token" | "oauth";
interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
}
export interface ProviderMeta {
  id: string;
  label: string;
  blurb: string;
  kind: ProviderKind;
  icon: React.ReactNode;
  fields?: ProviderField[];
}

// Provider catalog. Token-paste providers open a credentials dialog; OAuth
// providers kick off a redirect flow via integrations-svc.
export const PROVIDERS: ProviderMeta[] = [
  {
    id: "slack",
    label: "Slack",
    blurb: "Send & receive Slack DMs from Bliss-Work. Paste a bot token + signing secret.",
    kind: "token",
    icon: <Slack size={18} />,
    fields: [
      { key: "botToken", label: "Bot token", placeholder: "xoxb-…" },
      { key: "signingSecret", label: "Signing secret" },
    ],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    blurb: "WhatsApp Business Cloud API. Paste a system-user token + phone number ID.",
    kind: "token",
    icon: <MessageCircle size={18} />,
    fields: [
      { key: "accessToken", label: "System-user token" },
      { key: "phoneNumberId", label: "Phone number ID" },
      { key: "appSecret", label: "App secret" },
    ],
  },
  {
    id: "gmail",
    label: "Gmail",
    blurb: "Connect your Google account to send & read email from Bliss-Work.",
    kind: "oauth",
    icon: <Mail size={18} />,
  },
  {
    id: "outlook",
    label: "Outlook",
    blurb: "Connect Microsoft to send & read Outlook mail.",
    kind: "oauth",
    icon: <Mail size={18} />,
  },
  {
    id: "teams",
    label: "Microsoft Teams",
    blurb: "Connect Microsoft to send & receive Teams chat.",
    kind: "oauth",
    icon: <Users size={18} />,
  },
];

export function ConnectedAccounts() {
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const [dialogProvider, setDialogProvider] = useState<ProviderMeta | null>(null);

  const { data: connections = [], isError } = useQuery({
    queryKey: qk.integrations,
    queryFn: () => api.integrations(),
    // The service may not be reachable in every environment; don't hammer it.
    retry: 1,
  });

  const byProvider = (id: string) => connections.filter((c) => c.provider === id);

  const disconnect = useMutation({
    mutationFn: (id: string) => api.disconnectIntegration(id),
    onSuccess: () => {
      toast.success("Disconnected");
      void qc.invalidateQueries({ queryKey: qk.integrations });
      // Auto-derived handles are cascade-deleted with the connection.
      void qc.invalidateQueries({ queryKey: qk.providerIdentities });
    },
    onError: () => toast.error("Couldn't disconnect", { description: "Please try again." }),
  });

  const startOAuth = useMutation({
    mutationFn: (provider: string) =>
      api.connectIntegration(provider, {}, config.kind === "electron" ? "desktop" : "web"),
    onSuccess: (res) => {
      if (res.authorizeUrl) {
        // Google refuses OAuth inside an embedded webview, so on desktop the
        // authorize URL has to leave the app and come back via a deep link.
        if (config.openExternal) {
          config.openExternal(res.authorizeUrl);
          toast("Continue in your browser", {
            description: "We opened the sign-in page — come back when it's done.",
          });
        } else {
          window.location.href = res.authorizeUrl;
        }
      } else if (res.connection) {
        toast.success("Connected");
        void qc.invalidateQueries({ queryKey: qk.integrations });
      }
    },
    onError: () =>
      toast("Not available yet", {
        description: "This provider isn't configured on the server yet.",
      }),
  });

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
        <Plug size={16} className="text-accent" /> Connected accounts
      </h2>
      {isError && (
        <div className="mb-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning">
          The integrations service is unreachable right now. Connecting is disabled.
        </div>
      )}
      <div className="space-y-3">
        {PROVIDERS.map((p) => {
          const conns = byProvider(p.id);
          const connected = conns.some((c) => c.status === "connected");
          return (
            <div key={p.id} className="glass flex flex-wrap items-center gap-4 rounded-2xl p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                {p.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
                  {p.label}
                  {connected && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
                      <Check size={10} /> Connected
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted">{p.blurb}</div>
                {conns
                  .filter((c: IntegrationConnectionDTO) => c.status === "connected")
                  .map((c) => (
                    <div key={c.id} className="mt-1">
                      <div className="flex items-center gap-2 text-[11px] text-muted">
                        <span className="truncate">{c.displayLabel || c.id}</span>
                        <button
                          className="text-danger hover:underline"
                          disabled={disconnect.isPending}
                          onClick={() => disconnect.mutate(c.id)}
                        >
                          Disconnect
                        </button>
                      </div>
                      <WebhookSetup connection={c} />
                    </div>
                  ))}
              </div>
              <Button
                variant="subtle"
                size="sm"
                disabled={isError || startOAuth.isPending}
                onClick={() => (p.kind === "token" ? setDialogProvider(p) : startOAuth.mutate(p.id))}
              >
                {connected ? "Add another" : "Connect"}
              </Button>
            </div>
          );
        })}
      </div>
      <ConnectTokenDialog
        provider={dialogProvider}
        onClose={() => setDialogProvider(null)}
        onConnected={() => {
          setDialogProvider(null);
          void qc.invalidateQueries({ queryKey: qk.integrations });
        }}
      />
    </section>
  );
}

/**
 * The webhook URL to paste into Slack / Meta for THIS connection.
 *
 * Each connection gets its own URL, which is what lets us verify a delivery
 * against that connection's own signing secret. It matters most for the very
 * first request: Slack's `url_verification` handshake carries no team id at
 * all, so without the per-connection path there is nothing to look the secret
 * up by, and the whole setup would need a deployment-wide shared secret.
 *
 * Collapsed by default — it's setup detail, not something to re-read daily.
 */
function WebhookSetup({ connection }: { connection: IntegrationConnectionDTO }) {
  const [open, setOpen] = useState(false);
  if (!connection.webhookUrl) return null;

  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-[11px] font-medium text-accent hover:underline"
      >
        {open ? "Hide" : "Show"} webhook setup
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 rounded-xl bg-surface-2/60 p-2.5">
          <CopyLine label="Webhook URL" value={connection.webhookUrl} />
          {connection.webhookVerifyToken && (
            <CopyLine label="Verify token" value={connection.webhookVerifyToken} />
          )}
          <p className="text-[10px] text-muted">
            Paste these into the provider's dashboard. Deliveries are still verified by the
            provider's signature — this URL only identifies which connection they belong to.
          </p>
        </div>
      )}
    </div>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Copy failed", { description: "Select the text and copy it manually." });
    }
  };
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-medium text-muted">{label}</div>
      <div className="flex items-stretch gap-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-surface px-2 py-1 font-mono text-[10px] text-fg">
          {value}
        </code>
        <button
          onClick={copy}
          title={`Copy ${label}`}
          aria-label={`Copy ${label}`}
          className="shrink-0 rounded-lg px-1.5 text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}

function ConnectTokenDialog({
  provider,
  onClose,
  onConnected,
}: {
  provider: ProviderMeta | null;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { api } = useRuntime();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const fields = provider?.fields ?? [];
  const ready = fields.every((f) => (values[f.key] ?? "").trim().length > 0);

  const submit = async () => {
    if (!provider || !ready) return;
    setBusy(true);
    try {
      await api.connectIntegration(provider.id, values);
      toast.success(`${provider.label} connected`);
      setValues({});
      onConnected();
    } catch {
      toast.error(`Couldn't connect ${provider.label}`, {
        description: "Check the credentials and try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!provider} onClose={onClose} title={`Connect ${provider?.label ?? ""}`}>
      <p className="mb-3 text-xs text-muted">
        Credentials are encrypted at rest and never leave the server unencrypted.
      </p>
      <div className="space-y-3">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{f.label}</span>
            <Input
              value={values[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={!ready || busy} onClick={submit}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : "Connect"}
        </Button>
      </div>
    </Modal>
  );
}
