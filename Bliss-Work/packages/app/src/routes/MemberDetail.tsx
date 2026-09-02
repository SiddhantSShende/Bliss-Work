import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Download, MessageSquare, Users } from "lucide-react";
import { Avatar, Badge, Button, EmptyState, Spinner } from "@taskboard/ui";
import type { MemberDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { relativeTime } from "../lib/relativeTime";
import { useSelectedChat } from "../lib/selectedChat";
import { Tabs, type TabSpec } from "../features/Tabs";
import { ExportActivityDialog } from "../features/ExportActivityDialog";
import { MemberAdmin } from "../features/member/MemberAdmin";
import { MemberAnalytics } from "../features/member/MemberAnalytics";
import { MemberAuditLog } from "../features/member/MemberAuditLog";
import { MemberSessions } from "../features/member/MemberSessions";
import { MemberTimeline } from "../features/member/MemberTimeline";

type TabKey = "overview" | "timeline" | "analytics" | "sessions" | "admin" | "security";

/** One member's profile. Admins additionally get the lifecycle controls and the
 *  audit trail; everyone else sees the overview only. */
export function MemberDetail() {
  const { userId = "" } = useParams();
  const { api } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { openChat } = useSelectedChat();
  const me = useSession((s) => s.user)!;
  const isAdmin = me.roles.includes("org_admin");
  const isSelf = userId === me.id;
  const [tab, setTab] = useState<TabKey>("overview");
  const [patched, setPatched] = useState<MemberDTO | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  // This component is mounted once for `members/:userId`, so opening another
  // member reuses it and keeps the previous tab selected — which can be a tab
  // that isn't even in the new member's tab list, leaving a blank panel.
  useEffect(() => {
    setTab("overview");
    setExportOpen(false);
    // `patched` is only guarded by `patched?.id === userId`, so without this
    // reset, navigating A -> B -> back to A re-satisfies that guard and shows
    // A's stale locally-cached mutation result instead of the freshly
    // refetched roster data.
    setPatched(null);
  }, [userId]);

  // Admins read the roster (which includes suspended/removed people); everyone
  // else reads the plain directory, which by design lists only active members.
  const { data: members, isLoading: loadingMembers } = useQuery({
    queryKey: qk.members,
    queryFn: () => api.listMembers(),
    enabled: isAdmin,
  });
  const { data: directory = [], isLoading: loadingDir } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
  });
  // Last seen, NOT presence.
  //
  // This pane used to read the gateway's /presence set and render a green dot
  // plus "Online". Two things were wrong with that. An open socket is not a
  // person — a laptop left open all night reports online — and the presence set
  // itself could be stale, because a gateway that is killed rather than shut
  // down never runs the cleanup that removes its connections. So a member could
  // show as online days after they last touched the machine.
  //
  // The activity roster answers the question the screen is actually asking. It
  // is the SAME query key the members list uses, so arriving from that list is
  // a cache hit rather than a second request. Admin-only, by the server's
  // design; see lastSeen below for what the other cases show.
  const { data: activity = [] } = useQuery({
    queryKey: qk.activityRoster,
    queryFn: () => api.memberActivity(),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });
  const { data: conversations = [] } = useQuery({
    queryKey: qk.conversations,
    queryFn: () => api.conversations(),
  });

  const [opening, setOpening] = useState(false);
  // Opens the chat without saying anything. This used to post "👋 Hi {name}!"
  // because sending was the only way to create a conversation row.
  const openDm = async () => {
    const existing = conversations.find((c) => c.peerId === userId);
    // openChat rather than a nav to /app/chats/<id>: it selects and moves to
    // the section in one step, so the id is never put in the URL at all rather
    // than put there and redirected away.
    if (existing) return openChat(existing.id);
    setOpening(true);
    try {
      const { conversationId } = await api.openConversation(userId);
      // DMView reads its header from the conversation list, so refresh it before
      // navigating or a brand-new chat flashes "Conversation not found".
      await qc.invalidateQueries({ queryKey: qk.conversations });
      openChat(conversationId);
    } finally {
      setOpening(false);
    }
  };

  const fromRoster = members?.find((m) => m.id === userId);
  const fromDirectory = directory.find((u) => u.id === userId);
  // `patched` holds the DTO a just-completed mutation returned, so the header
  // reflects the new state on the same frame the toast appears rather than after
  // the roster refetch lands.
  const member: MemberDTO | null =
    (patched?.id === userId ? patched : null) ??
    fromRoster ??
    (fromDirectory
      ? {
          id: fromDirectory.id,
          username: fromDirectory.username,
          displayName: fromDirectory.displayName,
          email: fromDirectory.email,
          roles: fromDirectory.roles,
          status: "active",
          emailVerified: fromDirectory.emailVerified ?? true,
          createdAt: "",
          removedAt: null,
          avatarUrl: fromDirectory.avatarUrl,
        }
      : null);

  if ((isAdmin && loadingMembers) || loadingDir)
    return <div className="flex h-full items-center justify-center"><Spinner /></div>;

  if (!member)
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={<Users size={24} />} title="Member not found" hint="Pick another teammate on the left." />
      </div>
    );

  // A member can always see their OWN activity — that is the transparency half
  // of the bargain. Everyone else's is admin-only, enforced server-side by
  // `resolve_subject`; hiding the tab here is convenience, not the control.
  const canSeeActivity = isAdmin || isSelf;
  const tabs: TabSpec<TabKey>[] = [
    { key: "overview", label: "Overview" },
    ...(canSeeActivity
      ? ([
          { key: "timeline", label: "Activity" },
          { key: "analytics", label: "Analytics" },
          { key: "sessions", label: "Sessions" },
        ] as TabSpec<TabKey>[])
      : []),
    ...(isAdmin ? ([{ key: "admin", label: "Admin" }, { key: "security", label: "Security" }] as TabSpec<TabKey>[]) : []),
  ];
  /**
   * What to show on the Last seen row, or null to omit it entirely.
   *
   * Three cases, and the third is the interesting one:
   *   - Looking at yourself: you are demonstrably here.
   *   - Admin looking at anyone: the roster has a real timestamp.
   *   - Member looking at someone else: NO endpoint exposes another member's
   *     last-seen to a non-admin, and inventing one to fill this row would
   *     hand every member a presence oracle. Omitting it is the answer, and it
   *     matches hiding admins' status in the members list.
   */
  const lastSeen: string | null = isSelf
    ? "Now"
    : isAdmin
      ? (() => {
          const seen = activity.find((a) => a.userId === member.id)?.lastSeenAt;
          return seen ? relativeTime(seen) : "No recent activity";
        })()
      : null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border/70 bg-surface/60 px-5 py-3 backdrop-blur">
        {/* Not md:hidden. The list pane sits beside this on desktop, but the
            desktop APP is a single window with no browser chrome — hiding the
            only back control there left keyboard users with no way out. */}
        <button
          onClick={() => nav("/app/members")}
          title="Back to members"
          aria-label="Back to members"
          className="-ml-1 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <ChevronLeft size={20} />
        </button>
        {/* No `online` prop, so no presence dot — see lastSeen above. */}
        <Avatar name={member.displayName} src={member.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-fg">{member.displayName}</span>
            {member.roles.includes("org_admin") && <Badge tone="accent">Admin</Badge>}
            {member.status !== "active" && (
              <Badge tone={member.status === "suspended" ? "warning" : "danger"}>{member.status}</Badge>
            )}
          </div>
          <div className="truncate text-sm text-muted">@{member.username}</div>
        </div>
        {canSeeActivity && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExportOpen(true)}
            title="Export this member's activity"
          >
            <Download size={15} /> Export
          </Button>
        )}
        {!isSelf && member.status === "active" && (
          <Button
            size="sm"
            variant="secondary"
            loading={opening}
            onClick={() => void openDm()}
            className="hidden sm:inline-flex"
          >
            <MessageSquare size={15} /> Message
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {tabs.length > 1 && <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-5" />}

        {tab === "overview" && (
          <dl className="grid max-w-lg grid-cols-[9rem_1fr] gap-x-4 gap-y-3 text-sm">
            <Row label="Email" value={member.email} />
            <Row label="Username" value={`@${member.username}`} />
            <Row label="Role" value={member.roles.includes("org_admin") ? "Admin" : "Member"} />
            <Row label="Status" value={member.status} />
            {lastSeen && <Row label="Last seen" value={lastSeen} />}
            <Row label="Email verified" value={member.emailVerified ? "Yes" : "Not yet"} />
            {member.createdAt && <Row label="Joined" value={new Date(member.createdAt).toLocaleDateString()} />}
            {member.removedAt && <Row label="Removed" value={new Date(member.removedAt).toLocaleString()} />}
          </dl>
        )}

        {tab === "timeline" && canSeeActivity && (
          <div className="space-y-4">
            {isSelf && (
              <p className="rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent">
                This is your own activity record. Your workspace admins can see it too.
              </p>
            )}
            <MemberTimeline userId={isSelf ? "me" : member.id} />
          </div>
        )}

        {tab === "analytics" && canSeeActivity && (
          <MemberAnalytics userId={isSelf ? "me" : member.id} />
        )}

        {tab === "sessions" && canSeeActivity && (
          <MemberSessions userId={isSelf ? "me" : member.id} />
        )}

        {tab === "admin" && isAdmin && (
          <MemberAdmin member={member} isSelf={isSelf} onChanged={setPatched} />
        )}

        {tab === "security" && isAdmin && (
          <MemberAuditLog targetId={member.id} members={members ?? []} />
        )}
      </div>

      <ExportActivityDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        member={{ id: isSelf ? "me" : member.id, displayName: member.displayName }}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-fg">{value}</dd>
    </>
  );
}
