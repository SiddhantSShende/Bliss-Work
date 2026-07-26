/**
 * "My handles" — the identifiers that make an incoming message count as
 * tagging YOU.
 *
 * Handles from an OAuth connection are derived automatically and shown as
 * verified; you only need to add one by hand for platforms where the account is
 * shared, e.g. a Slack bot the whole workspace connects once — the workspace
 * knows your member id, but Bliss-Work has no way to learn it from the bot.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Loader2, Plus, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, EmptyState, Input } from "@taskboard/ui";
import { ApiError, type ProviderIdentityDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

const PROVIDERS = [
  { id: "slack", label: "Slack", placeholder: "U0123ABCD or you@work.com" },
  { id: "gmail", label: "Gmail", placeholder: "you@gmail.com" },
  { id: "outlook", label: "Outlook", placeholder: "you@company.com" },
  { id: "teams", label: "Teams", placeholder: "you@company.com" },
  { id: "whatsapp", label: "WhatsApp", placeholder: "15551234567" },
];

export function MyHandles() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [provider, setProvider] = useState("slack");
  const [handle, setHandle] = useState("");

  const { data: identities = [], isLoading, isError } = useQuery({
    queryKey: qk.providerIdentities,
    queryFn: () => api.providerIdentities(),
    retry: 1,
  });

  const add = useMutation({
    mutationFn: () => api.addProviderIdentity(provider, handle.trim()),
    onSuccess: () => {
      setHandle("");
      toast.success("Handle added");
      void qc.invalidateQueries({ queryKey: qk.providerIdentities });
    },
    onError: (err) => {
      // 409 is the meaningful one: a teammate already owns this handle, which
      // we refuse so nobody can farm someone else's mentions.
      if (err instanceof ApiError && err.status === 409) {
        toast.error("Already taken", { description: err.message });
        return;
      }
      toast.error("Couldn't add that handle", { description: "Please try again." });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeProviderIdentity(id),
    onSuccess: () => {
      toast("Handle removed");
      void qc.invalidateQueries({ queryKey: qk.providerIdentities });
    },
    onError: () => toast.error("Couldn't remove that handle"),
  });

  const canAdd = handle.trim().length > 0 && !add.isPending;

  return (
    <section>
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-fg">
        <Tag size={16} className="text-accent" /> My handles
      </h2>
      <p className="mb-3 text-xs text-muted">
        How we recognise a mention as yours. Accounts you connect are added automatically — add one
        by hand for shared connections like a workspace-wide Slack app.
      </p>

      {isError && (
        <div className="mb-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning">
          Couldn&apos;t load your handles right now.
        </div>
      )}

      <div className="glass rounded-2xl p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            aria-label="Platform"
            className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <Input
            value={handle}
            placeholder={PROVIDERS.find((p) => p.id === provider)?.placeholder}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canAdd) add.mutate();
            }}
            className="flex-1"
          />
          <Button size="sm" disabled={!canAdd} onClick={() => add.mutate()}>
            {add.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <>
                <Plus size={14} className="mr-1" /> Add
              </>
            )}
          </Button>
        </div>

        <div className="mt-3">
          {isLoading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : identities.length === 0 ? (
            <EmptyState
              icon={<Tag size={20} />}
              title="No handles yet"
              hint="Connect an account, or add one above."
            />
          ) : (
            <ul className="divide-y divide-border/50">
              {identities.map((i: ProviderIdentityDTO) => (
                <li key={i.id} className="flex items-center gap-3 py-2">
                  <span className="w-20 shrink-0 text-xs capitalize text-muted">{i.provider}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{i.handle}</span>
                  {i.source === "oauth" ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success"
                      title="Derived from a connected account"
                    >
                      <BadgeCheck size={10} /> Verified
                    </span>
                  ) : (
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">
                      Added by you
                    </span>
                  )}
                  <button
                    onClick={() => remove.mutate(i.id)}
                    disabled={remove.isPending}
                    aria-label={`Remove ${i.handle}`}
                    title="Remove"
                    className="rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
