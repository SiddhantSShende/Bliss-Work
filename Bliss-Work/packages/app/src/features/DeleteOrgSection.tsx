import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Input } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/**
 * Delete this workspace — the destructive end of the Organizations screen.
 *
 * The QA report asked for an org to be deleted automatically once its last
 * member was removed. This is the deliberate alternative; the reasoning lives
 * in services/auth-svc/app/routes/org_lifecycle.py, and the short version is
 * that member removal is reversible and destruction is not.
 *
 * Three things make this hard to do by accident, and each is here on purpose:
 * the slug has to be typed exactly, the deletion does not take effect for a
 * grace period, and while it is pending anyone with admin can call it off.
 */
export function DeleteOrgSection() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);

  const { data: org, isLoading } = useQuery({ queryKey: qk.org, queryFn: () => api.org() });

  const request = useMutation({
    mutationFn: () => api.requestOrgDelete(confirm.trim()),
    onSuccess: () => {
      // Every session in the org was just revoked server-side, so this refetch
      // is the last thing this client will successfully do. Telling the user
      // that plainly beats letting the next click fail with a bare 401.
      toast.success("Workspace scheduled for deletion", {
        description: "Everyone has been signed out. You can cancel until the deadline.",
      });
      void qc.invalidateQueries({ queryKey: qk.org });
      setConfirm("");
      setOpen(false);
    },
    onError: (e) => toast.error("Couldn't schedule deletion", { description: String(e) }),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelOrgDelete(),
    onSuccess: () => {
      toast.success("Deletion cancelled");
      void qc.invalidateQueries({ queryKey: qk.org });
    },
    onError: (e) => toast.error("Couldn't cancel deletion", { description: String(e) }),
  });

  if (isLoading || !org) return null;

  if (org.purgeAfter) {
    const when = new Date(org.purgeAfter);
    return (
      <section className="rounded-2xl border border-danger/40 bg-danger-soft/40 p-5">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-danger">
          <AlertTriangle size={16} /> This workspace is scheduled for deletion
        </h2>
        <p className="mb-3 text-sm text-muted">
          Everything in <strong className="text-fg">{org.name}</strong> — messages, files, tasks and
          activity — will be permanently destroyed on{" "}
          <strong className="text-fg">{when.toLocaleString()}</strong>. Until then this can be
          undone.
        </p>
        <Button
          variant="subtle"
          size="sm"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {cancel.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
          Cancel deletion
        </Button>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-danger/30 p-5">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-danger">
        <AlertTriangle size={16} /> Danger zone
      </h2>
      {!open ? (
        <>
          <p className="mb-3 text-sm text-muted">
            Deleting this workspace permanently destroys every message, file, task and activity
            record in it, for everyone.
          </p>
          <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
            Delete this workspace…
          </Button>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            This cannot be undone once the grace period ends. Everyone is signed out immediately.
            To confirm, type the workspace identifier{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg">{org.slug}</code>{" "}
            below.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-9 max-w-xs"
              value={confirm}
              placeholder={org.slug ?? ""}
              onChange={(e) => setConfirm(e.target.value)}
              aria-label="Type the workspace identifier to confirm"
            />
            {/* Checked here for feedback only — the server checks it too, and
                that check is the one that counts. */}
            <Button
              variant="subtle"
              size="sm"
              disabled={request.isPending || confirm.trim() !== (org.slug ?? "")}
              onClick={() => request.mutate()}
            >
              {request.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
              Delete workspace
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setConfirm(""); }}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
