import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Camera, Loader2 } from "lucide-react";
import { Avatar, Badge, Button, Input, PageHeader } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useGoBack } from "../lib/useGoBack";
import { makeThumbnail } from "../lib/thumbnail";
import { Field } from "./Onboarding";

/** Matches the `accept` attribute below and messaging-svc's own image-type
 *  sniffing — rejecting client-side gives a clear error instead of a 422. */
const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("failed to read image"));
    reader.readAsDataURL(blob);
  });
}

export function Profile() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const goBack = useGoBack();
  const user = useSession((s) => s.user)!;
  const setUser = useSession((s) => s.setUser);
  const [name, setName] = useState(user.displayName);
  const photoInputRef = useRef<HTMLInputElement>(null);

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

  // Same shape as `save` above — its own mutation because it fires the
  // instant a file is picked, independently of the display-name form and its
  // dirty/Cancel state.
  const uploadPhoto = useMutation({
    mutationFn: (avatarUrl: string) => api.updateProfile({ avatarUrl }),
    onSuccess: (updated) => {
      setUser(updated);
      toast.success("Profile photo updated");
      qc.invalidateQueries({ queryKey: qk.directory });
    },
    onError: (e) => toast.error("Could not update your photo", { description: String(e) }),
  });

  const onPhotoSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared unconditionally so picking the SAME file again still fires onChange.
    event.target.value = "";
    if (!file) return;
    if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) {
      toast.error("Unsupported file type", { description: "Please choose a JPG, PNG, or WebP image." });
      return;
    }
    // Resizes client-side (packages/app/src/lib/thumbnail.ts — the same
    // decode/scale/encode path chat attachments use for their posters) so the
    // upload is a small, uniform image rather than a multi-MB phone photo.
    const { thumb } = await makeThumbnail(file);
    if (!thumb) {
      toast.error("Couldn't process that image", { description: "Please try a different photo." });
      return;
    }
    uploadPhoto.mutate(await blobToDataUrl(thumb.blob));
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="My Profile" subtitle="Manage how you appear to your team." onBack={goBack} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-6">
          <div className="glass flex items-center gap-4 rounded-2xl p-5">
            <div className="relative shrink-0">
              <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={uploadPhoto.isPending}
                title={user.avatarUrl ? "Change photo" : "Add photo"}
                aria-label={user.avatarUrl ? "Change profile photo" : "Add profile photo"}
                className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-fg shadow-soft ring-2 ring-surface transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-60"
              >
                {uploadPhoto.isPending ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
              </button>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => void onPhotoSelected(e)}
              />
            </div>
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
