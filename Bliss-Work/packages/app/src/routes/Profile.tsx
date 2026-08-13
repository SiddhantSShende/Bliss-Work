import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Avatar, Badge, Button, Input, PageHeader } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useGoBack } from "../lib/useGoBack";
import { Field } from "./Onboarding";

export function Profile() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const goBack = useGoBack();
  const user = useSession((s) => s.user)!;
  const setUser = useSession((s) => s.setUser);
  const [name, setName] = useState(user.displayName);

  const dirty = name.trim().length > 0 && name.trim() !== user.displayName;
  const isAdmin = user.roles.includes("org_admin");

  const save = useMutation({
    mutationFn: () => api.updateProfile({ displayName: name.trim() }),
    onSuccess: (updated) => {
      setUser(updated);
      setName(updated.displayName);
      toast.success("Profile updated");
      qc.invalidateQueries({ queryKey: qk.directory });
    },
    onError: (e) => toast.error("Could not update profile", { description: String(e) }),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="My Profile" subtitle="Manage how you appear to your team." onBack={goBack} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-6">
          <div className="glass flex items-center gap-4 rounded-2xl p-5">
            <Avatar name={user.displayName} size="lg" />
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold tracking-tight text-fg">{user.displayName}</div>
              <div className="truncate text-sm text-muted">@{user.username}</div>
            </div>
            <Badge tone={isAdmin ? "accent" : "neutral"} className="ml-auto">
              {isAdmin ? "Admin" : "Member"}
            </Badge>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) save.mutate();
            }}
            className="glass space-y-4 rounded-2xl p-5"
          >
            <Field label="Display name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={80} />
            </Field>
            <ReadOnly label="Email" value={user.email} />
            <ReadOnly label="Username" value={`@${user.username}`} />
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setName(user.displayName)} disabled={!dirty}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending} disabled={!dirty}>
                Save changes
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[13px] font-medium text-fg/80">{label}</span>
      <p className="mt-1 text-sm text-muted">{value}</p>
    </div>
  );
}
