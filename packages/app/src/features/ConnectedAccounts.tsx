/**
 * Connected accounts — connect/disconnect external platforms.
 *
 * Credentials are sent to integrations-svc and stored ENCRYPTED at rest; tokens
 * are never returned to the client. Token-paste providers (Slack, WhatsApp)
 * collect their credentials in a dialog; OAuth providers (Gmail, Outlook,
 * Teams) redirect through the provider's consent screen.
 *
 * WhatsApp has one extra step. Validating its credentials only proves the token
 * can READ the business number's metadata — not that the number can send, and
 * not that the inbound webhook is wired. So a WhatsApp connection is created
 * `pending` and only becomes `connected` once a confirmation code has actually
 * travelled to the admin's own phone and back. Everything about the two-step
 * dialog below exists to make that round trip legible.
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
import { ApiError, type IntegrationConnectionDTO, type VerifyStartDTO } from "@taskboard/shared";
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
  /** Collected in the same dialog but NOT credentials: they drive the
   *  post-connect confirmation and are sent as separate request keys, never
   *  into the encrypted credential blob. */
  verifyFields?: ProviderField[];
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
    verifyFields: [
      {
        key: "to",
        label: "Your WhatsApp number",
        placeholder: "+15551234567",
        hint: "We send a confirmation code here to prove the connection works. Include the country code.",
      },
      {
        key: "template",
        label: "Confirmation template name",
        placeholder: "optional",
        optional: true,
        hint: "Only needed if your number hasn't messaged the business number recently — WhatsApp requires a Meta-approved template to start that conversation.",
      },
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

/** What the dialog is currently doing. `connection` is set when we're resuming
 *  confirmation for a connection that already exists (a pending one the user
 *  came back to), which skips straight past the credential fields. */
interface DialogTarget {
  provider: ProviderMeta;
  connection?: IntegrationConnectionDTO;
}

export function ConnectedAccounts() {
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<DialogTarget | null>(null);

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
                        {c.status === "pending" && (
                          <button
                            className="font-medium text-accent hover:underline"
                            onClick={() => setDialog({ provider: p, connection: c })}
                          >
                            Confirm number
                          </button>
                        )}
                        <button
                          className="text-danger hover:underline"
                          disabled={disconnect.isPending}
                          onClick={() => disconnect.mutate(c.id)}
                        >
                          Disconnect
                        </button>
                      </div>
                      {/* While pending, pasting the webhook URL into Meta is a
                          required step (and the fallback confirmation route
                          depends on it), so it isn't collapsed reference detail. */}
                      <WebhookSetup connection={c} defaultOpen={c.status === "pending"} />
                    </div>
                  ))}
              </div>
              <Button
                variant="subtle"
                size="sm"
                disabled={isError || startOAuth.isPending}
                onClick={() =>
                  p.kind === "token" ? setDialog({ provider: p }) : startOAuth.mutate(p.id)
                }
              >
                {connected ? "Add another" : "Connect"}
              </Button>
            </div>
          );
        })}
      </div>
      <ConnectTokenDialog
        target={dialog}
        onClose={() => setDialog(null)}
        onConnected={() => {
          setDialog(null);
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
        <Clock size={10} /> Pending confirmation
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
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">
        {field.label}
        {field.optional && <span className="ml-1 font-normal opacity-70">(optional)</span>}
      </span>
      <Input
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
      {field.hint && <span className="mt-1 block text-[10px] text-muted">{field.hint}</span>}
    </label>
  );
}

/**
 * Credentials → (WhatsApp only) confirmation code.
 *
 * Steps:
 *   "creds"  paste credentials; for WhatsApp, the admin's own number too
 *   "number" resuming a pending connection — credentials are already stored,
 *            we only need somewhere to send the code
 *   "code"   enter what arrived on the phone, or send us the keyword instead
 */
function ConnectTokenDialog({
  target,
  onClose,
  onConnected,
}: {
  target: DialogTarget | null;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { api } = useRuntime();
  const provider = target?.provider ?? null;
  const needsVerify = provider?.id === "whatsapp";

  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [connId, setConnId] = useState<string | null>(null);
  const [step, setStep] = useState<"creds" | "number" | "code">("creds");
  const [verify, setVerify] = useState<VerifyStartDTO | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog opens on a new target. Resuming a pending
  // connection skips the credential fields — they're already stored, and we
  // can't show them back (they never leave the server).
  useEffect(() => {
    if (!target) return;
    setValues({});
    setCode("");
    setVerify(null);
    setError(null);
    setBusy(false);
    setConnId(target.connection?.id ?? null);
    setStep(target.connection ? "number" : "creds");
  }, [target]);

  // The confirmation can also complete without this dialog: the admin replies
  // to the business number and the inbound webhook flips the status. Poll while
  // we're waiting on a code so that path closes the dialog on its own.
  const { data: connections } = useQuery({
    queryKey: qk.integrations,
    queryFn: () => api.integrations(),
    enabled: step === "code",
    refetchInterval: step === "code" ? 5000 : false,
  });
  useEffect(() => {
    if (step !== "code" || !connId) return;
    const me = connections?.find((c) => c.id === connId);
    if (me?.status === "connected") {
      toast.success("WhatsApp confirmed");
      onConnected();
    }
  }, [connections, connId, step, onConnected]);

  const credFields = provider?.fields ?? [];
  const verifyFields = provider?.verifyFields ?? [];
  const credsReady = credFields.every((f) => (values[f.key] ?? "").trim().length > 0);
  const numberReady = !needsVerify || (values.to ?? "").trim().length > 0;

  /** Ask the server to send a code to the number in `values.to`. */
  const sendCode = async (id: string) => {
    const to = (values.to ?? "").trim();
    const res = await api.startIntegrationVerification(id, {
      to,
      template: values.template?.trim() || undefined,
    });
    setVerify(res);
    setStep("code");
    if (res.delivery === "sent") {
      toast.success("Code sent", { description: `Check WhatsApp on ${to}.` });
    }
  };

  const submitCreds = async () => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      // Only the declared credential keys — the number and template name are
      // not credentials and must not end up in the encrypted creds blob.
      const creds = Object.fromEntries(credFields.map((f) => [f.key, values[f.key] ?? ""]));
      const res = await api.connectIntegration(provider.id, creds);
      const id = res.connection?.id ?? null;
      if (!needsVerify) {
        toast.success(`${provider.label} connected`);
        onConnected();
        return;
      }
      if (!id) throw new Error("no connection returned");
      setConnId(id);
      await sendCode(id);
    } catch (err) {
      setError(messageOf(err, `Couldn't connect ${provider.label}. Check the credentials.`));
    } finally {
      setBusy(false);
    }
  };

  /** Resuming, or resending after a wrong number: the connection already exists. */
  const submitNumber = async () => {
    if (!connId) return;
    setBusy(true);
    setError(null);
    try {
      await sendCode(connId);
    } catch (err) {
      setError(messageOf(err, "Couldn't send the code."));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (!connId) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmIntegrationVerification(connId, code.trim());
      toast.success("WhatsApp confirmed");
      onConnected();
    } catch (err) {
      setError(messageOf(err, "That code isn't right."));
    } finally {
      setBusy(false);
    }
  };

  const guide = provider ? GUIDES[provider.id] : undefined;

  return (
    <Modal
      open={!!provider}
      onClose={onClose}
      title={step === "code" ? "Confirm your number" : `Connect ${provider?.label ?? ""}`}
    >
      {step !== "code" && (
        <>
          <p className="mb-3 text-xs text-muted">
            Credentials are encrypted at rest and never leave the server unencrypted.
          </p>
          {guide && (
            <div className="mb-4 rounded-xl bg-surface-2/60 p-3">
              <GuideSteps guide={guide} />
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mb-3 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>
      )}

      {step === "creds" && (
        <div className="space-y-3">
          {credFields.map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={values[f.key] ?? ""}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
            />
          ))}
          {verifyFields.map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={values[f.key] ?? ""}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              inputMode={f.key === "to" ? "tel" : undefined}
            />
          ))}
        </div>
      )}

      {step === "number" && (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            This connection is waiting to be confirmed. Tell us where to send the code.
          </p>
          {verifyFields.map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={values[f.key] ?? ""}
              onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
              inputMode={f.key === "to" ? "tel" : undefined}
            />
          ))}
        </div>
      )}

      {step === "code" && verify && (
        <div className="space-y-3">
          {verify.delivery === "sent" ? (
            <>
              <p className="text-xs text-muted">
                We sent a 6-digit code to <strong>{values.to}</strong> on WhatsApp. It expires in 10
                minutes.
              </p>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">Confirmation code</span>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                />
              </label>
            </>
          ) : (
            <>
              {/* Meta refuses free-form messages to a number that hasn't
                  messaged the business recently. Going the other way needs no
                  template at all — and it proves the webhook works, which the
                  outbound path never does. */}
              <p className="text-xs text-muted">
                {verify.reason ?? "We couldn't message that number first."} Send this from WhatsApp
                to your business number instead — we'll confirm the moment it arrives.
              </p>
              <div className="space-y-2 rounded-xl bg-surface-2/60 p-2.5">
                <CopyLine label="Send this message" value={verify.replyKeyword ?? ""} />
                {verify.businessNumber && (
                  <CopyLine label="To this number" value={verify.businessNumber} />
                )}
              </div>
              <p className="text-[10px] text-muted">
                This needs the webhook URL registered in Meta first — it's shown on the connection
                once you close this dialog.
              </p>
            </>
          )}
          <button
            className="text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              setVerify(null);
              setCode("");
              setError(null);
              setStep("number");
            }}
          >
            Use a different number, or send a new code
          </button>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {step === "code" ? "Close" : "Cancel"}
        </Button>
        {step === "creds" && (
          <Button size="sm" disabled={!credsReady || !numberReady || busy} onClick={submitCreds}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : "Connect"}
          </Button>
        )}
        {step === "number" && (
          <Button size="sm" disabled={!numberReady || busy} onClick={submitNumber}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : "Send code"}
          </Button>
        )}
        {step === "code" && verify?.delivery === "sent" && (
          <Button size="sm" disabled={code.trim().length < 6 || busy} onClick={submitCode}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : "Confirm"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

/** Server messages here are written for the user (bad code, cooldown, WhatsApp's
 *  own rejection text), so show them rather than a generic failure. */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}
