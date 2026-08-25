/**
 * One meeting, said in full.
 *
 * The Meetings list used to be a single line per call — title, time, a join
 * button — which answered "what is next" and nothing else. Everything a person
 * actually asks before walking into a meeting (who called it, who is coming,
 * who has already arrived, is anything on screen, where is the link, is there a
 * recording of the one I missed) lived either in the room itself or nowhere. It
 * is all in the call DTO already; this card is where it gets said.
 *
 * Every control here is gated on the same rule the SERVER enforces, not on a
 * guess: the invite link is offered only to a host of a live meeting in the
 * hosting org, because store.CreateInvite refuses everyone else and a button
 * that 403s is worse than no button.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Calendar,
  Check,
  Copy,
  Disc,
  Globe,
  Hash,
  Link2,
  Phone,
  PlayCircle,
  ScreenShare,
  UserCheck,
  Users,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Spinner } from "@taskboard/ui";
import type { CallDTO, CallShareSource } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { useUserLabels } from "../lib/userLabel";
import { qk } from "../lib/queryBridge";
import { whenLabel, whenOf } from "../lib/meetingTime";
import { MeetingPeopleSheet, rosterOf, type PeopleTab } from "./MeetingPeople";

const KIND_LABEL: Record<CallDTO["kind"], string> = {
  MEETING: "Meeting",
  CHANNEL: "Channel call",
  DIRECT: "Call",
};

/** What the sharer picked, in the words a person would use for it. */
const SHARE_LABEL: Record<CallShareSource, string> = {
  SCREEN: "their screen",
  WINDOW: "a window",
  TAB: "a tab",
};

/** Signed media links last 600s server-side; refresh with room to spare. */
const LINK_REFRESH_MS = 8 * 60_000;

const chip =
  "inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-fg";

export function MeetingCard({
  call,
  onOpen,
  labelIds,
}: {
  call: CallDTO;
  onOpen: () => void;
  /**
   * The people to resolve names for, supplied by the LIST rather than computed
   * per card — and that distinction is the whole point.
   *
   * The lookup is cached by the id set it was asked for, so a card computing its
   * own set gets its own cache entry: twenty cards on screen meant twenty
   * requests, which is the N+1 this gateway exists to remove, reintroduced one
   * layer up. One shared set means one cache entry and one request for the whole
   * page.
   *
   * Optional so a card rendered on its own still resolves names; it then falls
   * back to its own participants.
   */
  labelIds?: readonly string[];
}) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user);
  // createdBy is included explicitly: an organiser who is not on the roster
  // still has to render, and leaving them out would be a silent "Unknown user".
  const ownIds = useMemo(
    () => [...call.participants.map((p) => p.userId), call.createdBy],
    [call.participants, call.createdBy],
  );
  const { nameOf } = useUserLabels(labelIds ?? ownIds);
  const [people, setPeople] = useState<PeopleTab | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const live = call.status === "LIVE";
  const recorded = call.recordingStatus === "READY";
  const over = call.status === "ENDED" || call.status === "CANCELLED";
  const isOrganiser = call.createdBy === me?.id;
  const roster = rosterOf(call);
  const externals = call.participants.filter((p) => p.external).length;
  const share = call.activeShares[0];

  // The three conditions store.CreateInvite checks, in the same order: only a
  // meeting has a guest list to extend, only a live one can be joined, and only
  // a HOST in the hosting org may widen it.
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
      return `${window.location.origin}/join?t=${encodeURIComponent(invite.token)}`;
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

  // Fetched rather than opened on click so the action can be a REAL anchor: a
  // window.open after an await is what popup blockers eat, and in Electron an
  // anchor routes through shell.openExternal instead of a renderer window.
  const recording = useQuery({
    queryKey: qk.callRecording(call.id),
    queryFn: () => api.callRecording(call.id),
    enabled: recorded,
    staleTime: LINK_REFRESH_MS,
    refetchInterval: LINK_REFRESH_MS,
    retry: 1,
  });

  return (
    <article className="glass flex flex-col gap-4 rounded-2xl p-4 sm:flex-row sm:items-start">
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
          live
            ? "bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_2px_10px_-2px_var(--color-accent)]"
            : "bg-accent-soft text-accent"
        }`}
      >
        {call.media === "audio" ? <Phone size={19} /> : <Video size={19} />}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold text-fg">
            {call.title || KIND_LABEL[call.kind]}
          </h3>
          <MeetingStatus status={call.status} />
          <span className="flex items-center gap-1 text-xs text-muted">
            {call.kind === "CHANNEL" && <Hash size={11} />}
            {KIND_LABEL[call.kind]}
          </span>
        </div>

        <div className="space-y-1 text-xs text-muted">
          <p className="truncate">
            Organised by{" "}
            <span className="font-medium text-fg">
              {isOrganiser
                ? "you"
                : nameOf(
                    call.createdBy,
                    call.participants.find((p) => p.userId === call.createdBy)?.username,
                  )}
            </span>
          </p>
          <p className="flex items-center gap-1.5" title={new Date(whenOf(call)).toLocaleString()}>
            <Calendar size={12} className="shrink-0" />
            {whenLabel(call)}
          </p>

          {canInvite && (
            <div className="flex items-center gap-1.5">
              <Link2 size={12} className="shrink-0" />
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
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
            </div>
          )}

          {call.recordingStatus === "RECORDING" && (
            // Said plainly, on every card, for the same reason the external
            // badge is: being recorded is not something anyone should have to
            // work out for themselves, or find out afterwards.
            <p className="flex items-center gap-1.5 font-medium text-danger">
              <Disc size={12} className="shrink-0 animate-pulse" />
              This call is being recorded
            </p>
          )}

          {(share || live) && (
            <p className="flex items-center gap-1.5">
              <ScreenShare size={12} className={`shrink-0 ${share ? "text-danger" : ""}`} />
              {share ? (
                <span>
                  <span className="font-medium text-fg">
                    {share.userId === me?.id
                      ? "You are"
                      : `${nameOf(
                          share.userId,
                          call.participants.find((p) => p.userId === share.userId)?.username,
                        )} is`}
                  </span>{" "}
                  sharing {SHARE_LABEL[share.source]}
                </span>
              ) : (
                <span>Nobody is sharing</span>
              )}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={chip} onClick={() => setPeople("invited")}>
            <Users size={12} /> Invited Members{" "}
            <span className="font-semibold text-fg">{roster.invited.length}</span>
          </button>
          <button type="button" className={chip} onClick={() => setPeople("joined")}>
            <UserCheck size={12} /> Joined{" "}
            <span className="font-semibold text-fg">{roster.joined.length}</span>
          </button>
          {externals > 0 && (
            // Same reasoning as in the room itself: someone outside the
            // organisation being here should never have to be inferred.
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning">
              <Globe size={12} /> {externals} external
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 sm:w-36 sm:pl-3">
        {!over && (
          <Button variant={live ? "primary" : "subtle"} size="sm" onClick={onOpen}>
            {live ? "Join" : isOrganiser ? "Start" : "Join"}
          </Button>
        )}
        {recorded &&
          (recording.data ? (
            <a
              href={api.mediaUrl(recording.data.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
            >
              <PlayCircle size={14} /> View recording
            </a>
          ) : (
            <span className="inline-flex h-8 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-3 text-[13px] font-medium text-muted">
              {recording.isError ? "No recording" : <Spinner className="h-4 w-4" />}
            </span>
          ))}
      </div>

      {people && (
        <MeetingPeopleSheet
          labelIds={labelIds ?? ownIds}
          call={call}
          open
          initialTab={people}
          onClose={() => setPeople(null)}
        />
      )}
    </article>
  );
}

/** The call's own state, in the one place the card says it. */
function MeetingStatus({ status }: { status: CallDTO["status"] }) {
  if (status === "LIVE") {
    return (
      <Badge tone="success">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live
      </Badge>
    );
  }
  if (status === "SCHEDULED") return <Badge tone="accent">Scheduled</Badge>;
  if (status === "CANCELLED") return <Badge>Cancelled</Badge>;
  return <Badge>Ended</Badge>;
}
