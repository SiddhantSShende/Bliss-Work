/**
 * Workspace OAuth apps — the setup step before anyone can connect Gmail,
 * Outlook or Teams.
 *
 * Integrations are user-driven: this workspace registers its OWN Google Cloud
 * project / Entra app registration and pastes the credentials here, rather than
 * authorizing a central Bliss-Work app. That keeps each org's third-party data
 * under its own agreements, and means one org's Google verification review
 * doesn't gate everyone else's.
 *
 * The client secret is WRITE-ONLY: the server never returns it, so the field is
 * always blank on load and saving again is how you rotate. The client ID is
 * shown, because it isn't secret (it travels in the authorize URL the browser
 * follows) and it's the only way to confirm which app is wired up.
 *
 * The redirect URIs come from the SERVER as literal strings rather than being
 * built here. Redirect-URI mismatch is the single most common OAuth setup
 * failure, and a client-side guess at the public base URL would be exactly the
 * kind of near-miss that causes it.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button, Input } from "@taskboard/ui";
import type { AppCredentialDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { Modal } from "./Modal";

type Vendor = "google" | "microsoft";

interface VendorMeta {
  vendor: Vendor;
  label: string;
  /** Where the user creates the app. */
  consoleLabel: string;
  consoleUrl: string;
  /** What they'll be looking for once they get there. */
  steps: string[];
}

const VENDOR_META: Record<Vendor, VendorMeta> = {
  google: {
    vendor: "google",
    label: "Google",
    consoleLabel: "Google Cloud Console",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    steps: [
      "Create (or pick) a project, then enable the Gmail API.",
      'Create an OAuth 2.0 Client ID of type "Web application".',
      "Add the redirect URI below to that client's Authorized redirect URIs.",
      "Copy the Client ID and Client secret here.",
    ],
  },
  microsoft: {
    vendor: "microsoft",
    label: "Microsoft",
    consoleLabel: "Microsoft Entra admin center",
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps",
    steps: [
      "Register a new application.",
      'Under Certificates & secrets, create a client secret and copy its VALUE (not the ID).',
      "Add both redirect URIs below as Web platform redirect URIs.",
      "Copy the Application (client) ID here. Add the Directory (tenant) ID only if the app is single-tenant.",
    ],
  },
};

export function WorkspaceApps() {
  const { api } = useRuntime();
  const [editing, setEditing] = useState<VendorMeta | null>(null);

  const { data: creds = [], isError } = useQuery({
    queryKey: qk.appCredentials,
    queryFn: () => api.appCredentials(),
    retry: 1,
  });

  return (
    // id is the scroll target for the "Set up" action on ConnectedAccounts'
    // 409 toast — connecting an OAuth provider fails until this is filled in.
    <section id="workspace-apps" className="scroll-mt-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-fg">
        <KeyRound size={16} className="text-accent" /> Workspace apps
      </h2>
      <p className="mb-3 text-xs text-muted">
        Gmail, Outlook and Teams connect through your own Google/Microsoft app, so your data stays
        under your own agreements. Set this up once per workspace — then everyone can connect their
        own account.
      </p>

      {isError && (
        <div className="mb-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning">
          The integrations service is unreachable right now.
        </div>
      )}

      <div className="space-y-3">
        {(Object.keys(VENDOR_META) as Vendor[]).map((vendor) => {
          const meta = VENDOR_META[vendor];
          const row = creds.find((c) => c.vendor === vendor);
          return (
            <VendorCard key={vendor} meta={meta} row={row} onEdit={() => setEditing(meta)} />
          );
        })}
      </div>

      <SetupDialog meta={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function VendorCard({
  meta,
  row,
  onEdit,
}: {
  meta: VendorMeta;
  row?: AppCredentialDTO;
  onEdit: () => void;
}) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const configured = !!row?.configured;
  const isServerFallback = row?.source === "server";

  const remove = useMutation({
    mutationFn: () => api.removeAppCredentials(meta.vendor),
    onSuccess: () => {
      toast.success(`${meta.label} app removed`);
      void qc.invalidateQueries({ queryKey: qk.appCredentials });
    },
    onError: () => toast.error("Couldn't remove", { description: "Please try again." }),
  });

  const confirmRemove = () => {
    // Existing connections keep working on their stored tokens until those
    // expire, so this is disruptive but not instantly destructive. Say so.
    const ok = window.confirm(
      `Remove the ${meta.label} app for this workspace?\n\n` +
        `Nobody will be able to connect ${row?.providers.join(" or ") ?? "these providers"} ` +
        `until you add credentials again. Accounts already connected keep working until ` +
        `their access expires.`,
    );
    if (ok) remove.mutate();
  };

  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
            {meta.label}
            {configured ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
                <Check size={10} /> {isServerFallback ? "Server default" : "Ready"}
              </span>
            ) : (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">
                Not set up
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            Unlocks {row?.providers.join(" + ") || "—"}
          </div>
          {configured && row?.clientId && (
            <div className="mt-1 truncate font-mono text-[11px] text-muted" title={row.clientId}>
              {row.clientId}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="subtle" size="sm" onClick={onEdit}>
            {configured && !isServerFallback ? "Update" : "Set up"}
          </Button>
          {configured && !isServerFallback && (
            <button
              onClick={confirmRemove}
              disabled={remove.isPending}
              title={`Remove the ${meta.label} app`}
              aria-label={`Remove the ${meta.label} app`}
              className="rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {isServerFallback && (
        <p className="mt-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11px] text-muted">
          Using this deployment's shared {meta.label} app. Add your own to keep this workspace's
          data under your own agreements.
        </p>
      )}
    </div>
  );
}

/** Copy-to-clipboard, because a hand-typed redirect URI is a mismatch waiting
 *  to happen. Falls back to selecting the text when the clipboard API is
 *  unavailable (older WebViews, insecure origins). */
function CopyField({ value, label }: { value: string; label: string }) {
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
      <div className="mb-1 text-[11px] font-medium text-muted">{label}</div>
      <div className="flex items-stretch gap-1.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] text-fg">
          {value}
        </code>
        <button
          onClick={copy}
          title={`Copy ${label}`}
          aria-label={`Copy ${label}`}
          className="shrink-0 rounded-lg px-2 text-muted transition hover:bg-surface-2 hover:text-fg"
        >
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

function SetupDialog({ meta, onClose }: { meta: VendorMeta | null; onClose: () => void }) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenant, setTenant] = useState("");
  const [pubsubTopic, setPubsubTopic] = useState("");

  const { data: creds = [] } = useQuery({
    queryKey: qk.appCredentials,
    queryFn: () => api.appCredentials(),
    enabled: !!meta,
  });
  const row = meta ? creds.find((c) => c.vendor === meta.vendor) : undefined;

  const reset = () => {
    setClientId("");
    setClientSecret("");
    setTenant("");
    setPubsubTopic("");
  };

  const save = useMutation({
    mutationFn: () => {
      if (!meta) throw new Error("no vendor");
      return api.saveAppCredentials(meta.vendor, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        // Send each field only to the vendor it applies to — the server
        // rejects the wrong one rather than storing a value it never reads.
        ...(meta.vendor === "microsoft" && tenant.trim() ? { tenant: tenant.trim() } : {}),
        ...(meta.vendor === "google" && pubsubTopic.trim()
          ? { pubsubTopic: pubsubTopic.trim() }
          : {}),
      });
    },
    onSuccess: () => {
      toast.success(`${meta?.label} app saved`);
      void qc.invalidateQueries({ queryKey: qk.appCredentials });
      reset();
      onClose();
    },
    onError: (e) =>
      toast.error("Couldn't save", {
        // The server's message is specific ("that looks like placeholder
        // text", "tenant applies to Microsoft only") — show it rather than a
        // generic failure the user can't act on.
        description: e instanceof Error ? e.message : "Check the credentials and try again.",
      }),
  });

  const ready = clientId.trim().length > 0 && clientSecret.trim().length > 0;

  return (
    <Modal
      open={!!meta}
      onClose={() => {
        reset();
        onClose();
      }}
      title={meta ? `${meta.label} app setup` : ""}
    >
      {meta && (
        <div className="space-y-4">
          <ol className="list-decimal space-y-1 pl-4 text-xs text-muted">
            {meta.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>

          <a
            href={meta.consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs font-medium text-accent hover:underline"
          >
            Open the {meta.consoleLabel} →
          </a>

          {(row?.redirectUris.length ?? 0) > 0 && (
            <div className="space-y-2 rounded-xl bg-surface-2/60 p-3">
              <div className="flex items-start gap-1.5 text-[11px] text-muted">
                <TriangleAlert size={13} className="mt-px shrink-0 text-warning" />
                <span>
                  These must be registered <strong>exactly</strong> as shown — a trailing slash or a
                  missing path causes <code>redirect_uri_mismatch</code>.
                </span>
              </div>
              {row!.redirectUris.map((uri) => (
                <CopyField key={uri} value={uri} label="Redirect URI" />
              ))}
            </div>
          )}

          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Client ID</span>
              <Input
                value={clientId}
                placeholder={row?.clientId || "…"}
                onChange={(e) => setClientId(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                Client secret
                {row?.configured && row.source === "org" && (
                  <span className="ml-1 font-normal">(re-enter to rotate)</span>
                )}
              </span>
              <Input
                type="password"
                value={clientSecret}
                autoComplete="new-password"
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </label>

            {meta.vendor === "microsoft" && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">
                  Directory (tenant) ID — single-tenant apps only
                </span>
                <Input
                  value={tenant}
                  placeholder={row?.tenant || "leave blank for multi-tenant"}
                  onChange={(e) => setTenant(e.target.value)}
                />
              </label>
            )}

            {meta.vendor === "google" && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">
                  Pub/Sub topic — optional, for Gmail push
                </span>
                <Input
                  value={pubsubTopic}
                  placeholder={row?.pubsubTopic || "projects/my-project/topics/gmail"}
                  onChange={(e) => setPubsubTopic(e.target.value)}
                />
              </label>
            )}
          </div>

          <p className="text-[11px] text-muted">
            The client secret is encrypted at rest and never sent back to the browser.
          </p>

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 size={14} className="animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
