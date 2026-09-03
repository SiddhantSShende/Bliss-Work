import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button, EmptyState, Input, PageHeader } from "@taskboard/ui";
import type { Role } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { Field } from "./Onboarding";
import { InviteList } from "../features/InviteList";
import { useGoBack } from "../lib/useGoBack";

export function InvitePage() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const goBack = useGoBack();
  const isAdmin = useSession((s) => s.user?.roles.includes("org_admin") ?? false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");

  const { data: invites = [] } = useQuery({
    queryKey: qk.invites,
    queryFn: () => api.listInvites(),
    enabled: isAdmin,
  });

  const send = useMutation({
    mutationFn: () => api.createInvite({ email: email.trim(), role }),
    onSuccess: () => {
      toast.success(`Invite sent to ${email.trim()}`, { description: "They'll get an email to join your workspace." });
      setEmail("");
      qc.invalidateQueries({ queryKey: qk.invites });
    },
    onError: (e) => toast.error("Could not send invite", { description: String(e) }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invites }),
    onError: (e) => toast.error("Could not revoke invite", { description: String(e) }),
  });

  if (!isAdmin)
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Invite teammates" onBack={goBack} />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon={<ShieldAlert size={24} />} title="Admins only" hint="Ask an organization admin to invite new teammates." />
        </div>
      </div>
    );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) send.mutate();
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Invite teammates"
        subtitle="Send an email invitation to join your workspace."
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-8">
          <form onSubmit={submit} className="glass rounded-2xl p-5">
            <div className="grid gap-3.5 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <Field label="Email">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@acme.com" required />
              </Field>
              <Field label="Role">
                <select
                  aria-label="Role"
                  className="h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  <option value="member">Member</option>
                  <option value="org_admin">Admin</option>
                </select>
              </Field>
              <Button type="submit" loading={send.isPending} className="h-11">
                <UserPlus size={16} /> Send
              </Button>
            </div>
          </form>

          <section>
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Pending invites</h2>
            <InviteList
              invites={invites}
              onRevoke={(id) => revoke.mutate(id)}
              revokingId={revoke.isPending ? revoke.variables : undefined}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
