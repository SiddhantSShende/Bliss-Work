import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Link2 } from "lucide-react";
import { toast } from "sonner";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { meetingJoinUrl } from "../lib/meetingDeepLink";

/**
 * The meeting's join link, for the people entitled to hand one out.
 *
 * Moved here verbatim from MeetingCard when the Meetings section became a
 * list-and-detail pair and the card went away — the logic is unchanged, it just
 * needed a home that was not a list row.
 *
 * ── Why the gate is spelled out rather than tried ────────────────────────────
 * The three conditions are the SAME three store.CreateInvite checks, in the
 * same order. A button that 403s is worse than no button, so this renders
 * nothing at all for everyone else rather than offering an action the server
 * will refuse: only a MEETING has a guest list to extend, only one that is not
 * over can be joined, and only a HOST in the HOSTING org may widen it.
 */
export function MeetingInviteLink({ call }: { call: CallDTO }) {
  const { api, config } = useRuntime();
  const me = useSession((s) => s.user);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const over = call.status === "ENDED" || call.status === "CANCELLED";
  const canInvite =
    call.kind === "MEETING" &&
    !over &&
    call.orgId === me?.orgId &&
    call.participants.some((p) => p.userId === me?.id && p.role === "HOST");

  const mintLink = useMutation({
    mutationFn: async () => {
      const invite = await api.createCallInvite(call.id);
      // The join route reads ?t=. The token comes back exactly once, so this is
      // the only moment it can become a URL — hence the local cache below:
      // copying twice must not mint (and spend) two links.
      return meetingJoinUrl(config.webBaseUrl, invite.token);
    },
    onError: () => toast.error("Couldn't create an invite link"),
  });

  const copyLink = async () => {
    const url = link ?? (await mintLink.mutateAsync().catch(() => null));
    if (!url) return;
    setLink(url);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Insecure origins and older WebViews have no clipboard API. The link is
      // on screen by now, so there is something to select rather than nothing.
      toast("Copy failed", { description: "Select the link and copy it manually." });
    }
  };

  if (!canInvite) return null;

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted">
      <Link2 size={13} className="shrink-0" />
      {link ? (
        <code className="min-w-0 truncate font-mono text-[11px] text-fg">{link}</code>
      ) : (
        <span>Invite link</span>
      )}
      <button
        type="button"
        onClick={() => void copyLink()}
        disabled={mintLink.isPending}
        title="Copy meeting link"
        aria-label="Copy meeting link"
        className="shrink-0 rounded-md p-1 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
