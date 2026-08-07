/**
 * Connected accounts — connect/disconnect external platforms.
 *
 * Credentials are sent to integrations-svc and stored ENCRYPTED at rest; tokens
 * are never returned to the client. Token-paste providers (Slack, WhatsApp)
 * collect their credentials in a dialog; OAuth providers (Gmail, Outlook,
 * Teams) redirect through the provider's consent screen.
 *
 * WhatsApp is BUSINESS ACCOUNTS ONLY, and lands `pending` rather than
 * `connected`. The server checks the account against Meta at connect time, but
 * no credential can prove the inbound webhook is wired — so the connection stays
 * pending until Meta itself calls our webhook URL, which happens when the admin
 * saves it in their dashboard. Nothing here asks for anyone's phone number: the
 * whole confirmation is business-side, so this page just has to say clearly
 * what is still outstanding and update itself when it lands.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Clock,
  Loader2,
  Mail,
  MessageCircle,
  Plug,
  Slack,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button, Input } from "@taskboard/ui";
import { ApiError, type IntegrationConnectionDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { Modal } from "./Modal";
import { GUIDES, GuideSteps } from "./integrationGuides";

type ProviderKind = "token" | "oauth";
interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
}
export interface ProviderMeta {
  id: string;
  label: string;
  blurb: string;
  kind: ProviderKind;
  icon: React.ReactNode;
  /** Credential fields. These map 1:1 onto the server's ProviderSpec.fields and
   *  are the ONLY keys it will persist — anything else is dropped. */
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
    blurb:
      "WhatsApp Business Cloud API. For WhatsApp Business accounts only — the number must be verified with Meta.",
    kind: "token",
    icon: <MessageCircle size={18} />,
    // All four come off Meta's WhatsApp → API Setup page, in this order. The
    // Business Account ID isn't decoration: it's what lets the server prove the
    // number actually belongs to an approved business rather than just existing.
    fields: [
      { key: "accessToken", label: "System-user token" },
      {
        key: "wabaId",
        label: "WhatsApp Business Account ID",
        hint: "Shown directly above the Phone number ID on Meta's API Setup page.",
      },
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
    // A pending connection is finished in Meta's dashboard, not here, so there
    // is no in-app action to hang an update off. Poll while any connection is
    // waiting so the card flips to Connected on its own, then stop.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((c) => c.status === "pending") ? 5000 : false,
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
    onError: (err) => {
      // 409 means this workspace hasn't registered its own Google/Microsoft
      // OAuth app yet — the ONE failure the user can fix themselves, and the
      // server already says exactly what's missing. Showing a generic "not
      // available yet" threw that away and read like a missing feature they had
      // to wait for, so people saw only the raw 409 in the console.
      if (err instanceof ApiError && err.status === 409) {
        toast("Set up needed", {
          description: err.message,
          action: {
            label: "Set up",
            onClick: () =>
              document
                .getElementById("workspace-apps")
                ?.scrollIntoView({ behavior: "smooth", block: "start" }),
          },
        });
        return;
      }
      toast("Couldn't start connecting", {
        description:
          err instanceof ApiError && err.message
            ? err.message
            : "Something went wrong. Please try again.",
      });
    },
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
                  {connected && <StatusPill status="connected" />}
                </div>
                <div className="mt-0.5 text-xs text-muted">{p.blurb}</div>
                <SetupGuide providerId={p.id} />
                {conns
                  // Pending connections are shown too — a WhatsApp connection
                  // spends its whole setup in that state, and hiding it left
                  // the user with a Connect button that appeared to do nothing.
                  .filter((c) => c.status !== "revoked")
                  .map((c) => (
                    <div key={c.id} className="mt-1">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                        <span className="truncate">{c.displayLabel || c.id}</span>
                        {c.status === "pending" && <StatusPill status="pending" />}
                        <button
                          className="text-danger hover:underline"
                          disabled={disconnect.isPending}
                          onClick={() => disconnect.mutate(c.id)}
                        >
                          Disconnect
                        </button>
                      </div>
                      {c.status === "pending" && (
                        // No button here on purpose: the remaining step happens
                        // in Meta's dashboard, and offering an in-app action
                        // would imply there is something left to do here.
                        <p className="mt-1 text-[11px] text-warning">
                          Paste the webhook URL and verify token below into Meta (WhatsApp →
                          Configuration → Webhook → Edit) and subscribe to <code>messages</code>.
                          This page updates itself the moment Meta calls.
                        </p>
                      )}
                      {/* While pending, pasting the webhook URL into Meta is THE
                          remaining step — and answering the request it triggers
                          is what confirms the connection — so it isn't collapsed
                          reference detail at this moment. */}
                      <WebhookSetup connection={c} defaultOpen={c.status === "pending"} />
                    </div>
                  ))}
              </div>
              <Button
                variant="subtle"
                size="sm"
                disabled={isError || startOAuth.isPending}
                onClick={() =>
                  p.kind === "token" ? setDialogProvider(p) : startOAuth.mutate(p.id)
                }
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

function StatusPill({ status }: { status: "connected" | "pending" }) {
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-medium text-warning">
        <Clock size={10} /> Waiting for Meta
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
      <Check size={10} /> Connected
    </span>
  );
}

/** Where to get the credentials this provider is asking for. Collapsed, because
 *  it's read once during setup and never again — same reasoning as WebhookSetup. */
function SetupGuide({ providerId }: { providerId: string }) {
  const [open, setOpen] = useState(false);
  const guide = GUIDES[providerId];
  if (!guide) return null;

  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-[11px] font-medium text-accent hover:underline"
      >
        {open ? "Hide" : "Show"} setup guide
      </button>
      {open && (
        <div className="mt-1.5 rounded-xl bg-surface-2/60 p-2.5">
          <GuideSteps guide={guide} />
        </div>
      )}
    </div>
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
function WebhookSetup({
  connection,
  defaultOpen = false,
}: {
  connection: IntegrationConnectionDTO;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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

function FieldInput({
  field,
  value,
  onChange,
  ...rest
}: {
  field: ProviderField;
  value: string;
  onChange: (v: string) => void;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  // The hint is DESCRIBED-BY, not part of the label. Nesting it inside <label>
  // folds it into the field's accessible name, so a screen reader announces
  // "WhatsApp Business Account ID Shown directly above the Phone number ID on
  // Meta's API Setup page" as the name of the box — and two fields whose hints
  // mention each other stop being tellable apart at all.
  const hintId = field.hint ? `field-hint-${field.key}` : undefined;
  return (
    <div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">
          {field.label}
          {field.optional && <span className="ml-1 font-normal opacity-70">(optional)</span>}
        </span>
        <Input
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hintId}
          {...rest}
        />
      </label>
      {field.hint && (
        <p id={hintId} className="mt-1 text-[10px] text-muted">
          {field.hint}
        </p>
      )}
    </div>
  );
}

/**
 * The credentials dialog. One step for every token-paste provider.
 *
 * It briefly had a second and third step for WhatsApp, to collect an admin's own
 * phone number and a confirmation code. That went away with the move to
 * Business-accounts-only: a WhatsApp connection is now confirmed by Meta's own
 * webhook verification request, which involves nobody's handset.
 */
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
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog opens on a different provider, so a failed Slack
  // attempt can't leave its error sitting above WhatsApp's fields.
  useEffect(() => {
    if (!provider) return;
    setValues({});
    setError(null);
    setBusy(false);
  }, [provider]);

  const fields = provider?.fields ?? [];
  const ready = fields.every((f) => (values[f.key] ?? "").trim().length > 0);
  const guide = provider ? GUIDES[provider.id] : undefined;

  const submit = async () => {
    if (!provider || !ready) return;
    setBusy(true);
    setError(null);
    try {
      // Only the declared fields, so stray dialog state can never be persisted.
      const creds = Object.fromEntries(fields.map((f) => [f.key, values[f.key]?.trim() ?? ""]));
      const res = await api.connectIntegration(provider.id, creds);
      // WhatsApp comes back `pending` — it still needs Meta to call our webhook.
      // Saying "connected" here would be a lie the card immediately contradicts.
      if (res.connection?.status === "pending") {
        toast("Almost there", {
          description: "Paste the webhook URL into Meta to finish connecting.",
        });
      } else {
        toast.success(`${provider.label} connected`);
      }
      onConnected();
    } catch (err) {
      // The server's messages here are written for the admin — which business
      // check failed, or that the token is missing a permission. A generic
      // "check your credentials" would discard the only useful part.
      setError(messageOf(err, `Couldn't connect ${provider.label}. Check the details above.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!provider} onClose={onClose} title={`Connect ${provider?.label ?? ""}`}>
      <p className="mb-3 text-xs text-muted">
        Credentials are encrypted at rest and never leave the server unencrypted.
      </p>
      {guide && (
        <div className="mb-4 rounded-xl bg-surface-2/60 p-3">
          <GuideSteps guide={guide} />
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
      )}

      <div className="space-y-3">
        {fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={values[f.key] ?? ""}
            onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
          />
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

/** Server messages here are written for the user (bad code, cooldown, WhatsApp's
 *  own rejection text), so show them rather than a generic failure. */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}
