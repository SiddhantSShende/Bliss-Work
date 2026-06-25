import { useState } from "react";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { Modal } from "./Modal";
import { Field } from "../routes/Onboarding";

export function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useRuntime();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "org_admin">("member");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createInvite({ email, role });
      toast.success(`Invite sent to ${email}`, {
        description: "Check Mailpit (localhost:8025) for the email.",
      });
      setEmail("");
      onClose();
    } catch (err) {
      toast.error("Could not send invite", { description: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Invite a teammate">
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@acme.com" required />
        </Field>
        <Field label="Role">
          <select
            aria-label="Role"
            className="h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            value={role}
            onChange={(e) => setRole(e.target.value as "member" | "org_admin")}
          >
            <option value="member">Member</option>
            <option value="org_admin">Admin</option>
          </select>
        </Field>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            {busy ? "Sending…" : "Send invite"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
