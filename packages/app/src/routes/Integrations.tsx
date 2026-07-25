/**
 * External Integrations section.
 *
 * Two concerns live here:
 *  1. Connected accounts — connect/disconnect external platforms (Slack,
 *     WhatsApp, Gmail, Outlook, Teams). Credentials are sent to integrations-svc
 *     and stored ENCRYPTED at rest; tokens are never returned to the client.
 *  2. Forwarding activity — the "who forwarded my messages" feed. When someone
 *     forwards a message you sent, it shows up here (and you get a live toast),
 *     expandable into the full downstream forward tree.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plug,
  Forward,
  ChevronRight,
  ChevronDown,
  Slack,
  MessageCircle,
  Mail,
  Users,
  Loader2,
  Check,
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { Button, Input, PageHeader, EmptyState } from "@taskboard/ui";
import type {
  ForwardActivityDTO,
  ForwardEdgeDTO,
  IntegrationConnectionDTO,
  ProviderActivityDTO,
  UserDTO,
} from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { Modal } from "../features/Modal";

type ProviderKind = "token" | "oauth";
interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
}
interface ProviderMeta {
  id: string;
  label: string;
  blurb: string;
  kind: ProviderKind;
  icon: React.ReactNode;
  fields?: ProviderField[];
}

// Provider catalog. Token-paste providers open a credentials dialog; OAuth
// providers kick off a redirect flow via integrations-svc.
const PROVIDERS: ProviderMeta[] = [
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

export function Integrations() {
  const qc = useQueryClient();

  // OAuth return trip: the callback redirects to /app/integrations?connected=…
  // (or ?error=…). Toast the outcome, refresh the list, and clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) {
      toast.success(`Connected ${connected}`);
      void qc.invalidateQueries({ queryKey: qk.integrations });
    } else if (error) {
      toast.error("Couldn't connect", {
        description: error === "oauth_failed" ? "The authorization didn't complete." : error,
      });
    }
    if (connected || error) window.history.replaceState({}, "", window.location.pathname);
  }, [qc]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="External Integrations"
        subtitle="Connect other platforms and track where your messages travel — all from one place."
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-8">
          <ConnectedAccounts />
          <HubActivity />
          <ForwardingActivity />
        </div>
      </div>
    </div>
  );
}

// ── Connected accounts ────────────────────────────────────────────────────────

function ConnectedAccounts() {
  const { api } = useRuntime();
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
    },
    onError: () => toast.error("Couldn't disconnect", { description: "Please try again." }),
  });

  const startOAuth = useMutation({
    mutationFn: (provider: string) => api.connectIntegration(provider),
    onSuccess: (res) => {
      if (res.authorizeUrl) {
        window.location.href = res.authorizeUrl;
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
            <div key={p.id} className="glass flex items-center gap-4 rounded-2xl p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                {p.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  {p.label}
                  {connected && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
                      <Check size={10} /> Connected
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted">{p.blurb}</div>
                {conns
                  .filter((c) => c.status === "connected")
                  .map((c) => (
                    <div key={c.id} className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                      <span className="truncate">{c.displayLabel || c.id}</span>
                      <button
                        className="text-danger hover:underline"
                        disabled={disconnect.isPending}
                        onClick={() => disconnect.mutate(c.id)}
                      >
                        Disconnect
                      </button>
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

// ── Unified hub activity ──────────────────────────────────────────────────────

function HubActivity() {
  const { api } = useRuntime();
  const { data: activity = [], isLoading } = useQuery({
    queryKey: qk.integrationActivity,
    queryFn: () => api.integrationActivity(),
    // Live-pushed via integration.activity.created; poll as a fallback.
    refetchInterval: 30_000,
  });

  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-fg">
        <Activity size={16} className="text-accent" /> Hub activity
      </h2>
      <p className="mb-3 text-xs text-muted">
        Messages sent and received across your connected accounts, in one timeline.
      </p>
      {isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : activity.length === 0 ? (
        <div className="glass rounded-2xl p-6">
          <EmptyState
            icon={<Activity size={22} />}
            title="No activity yet"
            hint="Connect an account, then messages to/from it show up here."
          />
        </div>
      ) : (
        <div className="glass divide-y divide-border/50 overflow-hidden rounded-2xl">
          {activity.map((a: ProviderActivityDTO) => {
            const inbound = a.direction === "inbound";
            const forwarded = (a.status ?? "").includes("forwarded");
            return (
              <div key={a.id} className="flex items-start gap-3 p-3">
                <div
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                    inbound ? "bg-success-soft text-success" : "bg-accent-soft text-accent"
                  }`}
                >
                  {inbound ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span className="font-medium capitalize text-fg">{a.provider}</span>
                    <span>·</span>
                    <span className="truncate">{inbound ? `from ${a.peer}` : `to ${a.peer}`}</span>
                    {forwarded && (
                      <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
                        forwarded
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-sm text-fg">{a.body || "—"}</div>
                </div>
                <span className="shrink-0 text-[10px] text-muted/70">
                  {new Date(a.occurredAt).toLocaleTimeString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Forwarding activity ───────────────────────────────────────────────────────

function ForwardingActivity() {
  const { api } = useRuntime();
  const { data: activity = [], isLoading } = useQuery({
    queryKey: qk.forwardActivityFeed,
    queryFn: () => api.myForwardActivity(),
  });

  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-fg">
        <Forward size={16} className="text-accent" /> Forwarding activity
      </h2>
      <p className="mb-3 text-xs text-muted">
        When someone forwards a message you sent, it appears here — with who forwarded it, to
        whom, on which platform, and when.
      </p>
      {isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : activity.length === 0 ? (
        <div className="glass rounded-2xl p-6">
          <EmptyState
            icon={<Forward size={22} />}
            title="No forwards yet"
            hint="Forward a message from any chat, and its journey shows up here."
          />
        </div>
      ) : (
        <div className="space-y-2">
          {activity.map((a) => (
            <ForwardActivityRow key={a.rootMessageId} item={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function ForwardActivityRow({ item }: { item: ForwardActivityDTO }) {
  const { api } = useRuntime();
  const [open, setOpen] = useState(false);

  const { data: dir = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const nameOf = (id?: string | null) =>
    (dir as UserDTO[]).find((u) => u.id === id)?.displayName ?? "someone";

  const { data: edges = [], isLoading } = useQuery({
    queryKey: qk.forwardActivity(item.rootMessageId),
    queryFn: () => api.messageForwards(item.rootMessageId),
    enabled: open,
  });

  return (
    <div className="glass rounded-2xl">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        {open ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">“{item.preview}”</div>
          <div className="mt-0.5 text-xs text-muted">
            forwarded {item.forwardCount} {item.forwardCount === 1 ? "time" : "times"} · last{" "}
            {new Date(item.lastForwardedAt).toLocaleString()}
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-border/60 p-4 pt-3">
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={12} className="animate-spin" /> Loading forward tree…
            </div>
          ) : edges.length === 0 ? (
            <div className="text-xs text-muted">No forwards recorded.</div>
          ) : (
            <ul className="space-y-1.5">
              {edges.map((e: ForwardEdgeDTO) => {
                const to = e.forwardedTo ? nameOf(e.forwardedTo) : e.forwardedToExternal ?? "someone";
                const via = e.platform === "blisswork" ? "" : ` · via ${e.platform}`;
                return (
                  <li
                    key={e.id}
                    className="flex items-center gap-2 text-xs text-fg"
                    style={{ paddingLeft: `${(e.depth - 1) * 16}px` }}
                  >
                    <Forward size={12} className="shrink-0 text-accent" />
                    <span>
                      <span className="font-medium">{nameOf(e.forwardedBy)}</span> forwarded to{" "}
                      <span className="font-medium">{to}</span>
                      <span className="text-muted">
                        {via} · {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
