import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Link2 } from "lucide-react";
import type { CallDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { useCallInviteLink } from "../lib/useCallInviteLink";

/**
 * The meeting's join link, for the people entitled to hand one out.
 *
 * The mint-and-copy logic is shared with CallRoom's own invite control (see
 * lib/useCallInviteLink) — this component owns only the gate and the
 * icon-swap feedback on a successful copy.
 *
 * ── Why the gate is spelled out rather than tried ────────────────────────────
 * The three conditions are the SAME three store.CreateInvite checks, in the
 * same order. A button that 403s is worse than no button, so this renders
 * nothing at all for everyone else rather than offering an action the server
 * will refuse: only a MEETING has a guest list to extend, only one that is not
 * over can be joined, and only a HOST in the HOSTING org may widen it.
 */
export function MeetingInviteLink({ call }: { call: CallDTO }) {
  const { t } = useTranslation("meetings");
  const me = useSession((s) => s.user);
  const { link, isPending, copyLink } = useCallInviteLink(call.id);
  const [copied, setCopied] = useState(false);

  const over = call.status === "ENDED" || call.status === "CANCELLED";
  const canInvite =
    call.kind === "MEETING" &&
    !over &&
    call.orgId === me?.orgId &&
    call.participants.some((p) => p.userId === me?.id && p.role === "HOST");

  const onCopy = async () => {
    if (!(await copyLink())) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!canInvite) return null;

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted">
      <Link2 size={13} className="shrink-0" />
      {link ? (
        <code className="min-w-0 truncate font-mono text-[11px] text-fg">{link}</code>
      ) : (
        <span>{t("inviteLink.label")}</span>
      )}
      <button
        type="button"
        onClick={() => void onCopy()}
        disabled={isPending}
        title={t("inviteLink.copy")}
        aria-label={t("inviteLink.copy")}
        className="shrink-0 rounded-md p-1 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
