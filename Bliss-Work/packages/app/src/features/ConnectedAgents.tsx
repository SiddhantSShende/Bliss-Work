import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, Chrome, Laptop, Trash2 } from "lucide-react";
import { Badge, Button, Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/**
 * The devices and browsers reporting activity for this person, and the way to
 * stop any of them.
 *
 * Revocation has to be possible from HERE and not only from the device: a
 * laptop that was lost, wiped or handed back cannot unpair itself, and a
 * credential that can only be withdrawn from the machine holding it is a
 * credential that cannot really be withdrawn.
 *
 * Lives on the member's own activity page, not in an admin screen — the person
 * being recorded is the person who controls the pairing.
 */
export function ConnectedAgents() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: agents = [], isLoading } = useQuery({
    queryKey: qk.agentTokens,
    queryFn: () => api.listAgentTokens(),
  });

  const create = useMutation({
    mutationFn: () => api.createAgentToken("extension", "Browser extension"),
    onSuccess: (t) => {
      // Held in component state only, and only until the page is left. This is
      // the one and only time the raw value exists outside the extension.
      setMinted(t.token);
      setCopied(false);
      qc.invalidateQueries({ queryKey: qk.agentTokens });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not create a code"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAgentToken(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agentTokens });
      toast.success("Disconnected — it will stop reporting within a minute");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not disconnect"),
  });

  const copy = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy — select the code and copy it manually");
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-border/60 p-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">Connected devices</h3>
        <p className="text-xs leading-relaxed text-muted">
          The desktop app and browser extension can add what you use outside BlissWork
          to your record. Disconnect any of them here — it works even if you no longer
          have the device.
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-4"><Spinner /></div>
      ) : agents.length === 0 ? (
        <p className="text-sm text-muted">Nothing connected.</p>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {agents.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-lg p-2 hover:bg-surface-2">
              {a.kind === "desktop" ? (
                <Laptop size={16} className="shrink-0 text-muted" />
              ) : (
                <Chrome size={16} className="shrink-0 text-muted" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg">
                  {a.label || (a.kind === "desktop" ? "Desktop app" : "Browser extension")}
                </div>
                <div className="text-xs text-muted">
                  {a.lastUsedAt
                    ? `Last reported ${new Date(a.lastUsedAt).toLocaleString()}`
                    : "Never reported yet"}
                </div>
              </div>
              {!a.lastUsedAt && <Badge tone="neutral">not yet used</Badge>}
              <Button
                size="sm"
                variant="ghost"
                title="Disconnect"
                aria-label={`Disconnect ${a.label || a.kind}`}
                loading={revoke.isPending && revoke.variables === a.id}
                onClick={() => revoke.mutate(a.id)}
              >
                <Trash2 size={15} />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {minted ? (
        <div className="space-y-2 rounded-lg bg-accent-soft p-3">
          <p className="text-xs font-medium text-accent">
            Paste this into the BlissWork extension. It's shown once and can't be
            recovered — generate a new one if you lose it.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1.5 font-mono text-xs text-fg">
              {minted}
            </code>
            <Button size="sm" variant="secondary" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="secondary" loading={create.isPending} onClick={() => create.mutate()}>
          Connect a browser extension
        </Button>
      )}
    </section>
  );
}
