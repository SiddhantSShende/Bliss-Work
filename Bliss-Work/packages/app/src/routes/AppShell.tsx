import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MailWarning, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { NotificationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk, WsEventBridge } from "../lib/queryBridge";
import { useInboxPeers } from "../lib/useInboxPeers";
import { listSectionOf, railSectionOf } from "../lib/section";
import { useSelectedChat } from "../lib/selectedChat";
import { TelemetryBridge } from "../lib/telemetry";
import { CallProvider } from "../lib/useCall";
import { CallUI } from "../features/CallUI";
import { NotificationsPanel } from "../features/NotificationsPanel";
import { TopNavbar } from "../features/TopNavbar";
import { Rail } from "./Rail";
import { ChatsList } from "./ChatsList";
import { TasksList } from "./TasksList";
import { ChannelsList } from "./ChannelsList";
import { MembersList } from "./MembersList";
import { MailFolders } from "./MailFolders";

export function AppShell() {
  const { api } = useRuntime();
  const loc = useLocation();
  const [notifOpen, setNotifOpen] = useState(false);

  const { data: notifications = [] } = useQuery({
    queryKey: qk.notifications,
    queryFn: () => api.notifications(),
  });
  const unread = notifications.filter((n: NotificationDTO) => !n.read).length;

  // Per-section alert counts for the left rail. Mail shows the summed unread
  // across counterparties; Tasks surfaces unread task notifications so a new
  // ack/complete/ignore/left is visible without opening the bell.
  //
  // Mail kinds only (see INBOX_KINDS): the badge has to count what the mailbox
  // actually lists, or it points at rows the user cannot find there. Tasks
  // already have their own badge beside it, so counting them here would also
  // be counting them twice.
  const { data: inboxPeers = [] } = useInboxPeers();
  const inboxUnread = inboxPeers.reduce((sum, p) => sum + (p.unreadCount || 0), 0);
  const railBadges: Record<string, number> = { mail: inboxUnread, tasks: unread };

  // mail/chats/tasks/channels drive the contextual list pane; utility pages
  // (search/invite/profile) render full-width with no list pane. Integrations
  // and Org are full-width but ARE rail items, so the rail gets its own
  // highlight-only key. Both live in lib/section.ts, which telemetry shares —
  // three copies of this prefix chain is three chances for a new route to be
  // classified inconsistently.
  const section = listSectionOf(loc.pathname);
  const railSection = railSectionOf(loc.pathname);

  // On phones we only have room for ONE pane. A path with a third segment
  // (/app/members/:userId, /app/tasks/:view) is a "detail" → show the main
  // content; a bare section index (/app/members) → show the list pane. md+
  // shows both panes side by side, so these flags are ignored there.
  //
  // Chats are the exception, and have to be asked rather than counted: the
  // section is always at /app/chats now, because a conversation id has no
  // business being in a URL (lib/selectedChat). Counting segments there would
  // pin a phone to the chat list and leave a tapped conversation unreachable.
  const { selectedId } = useSelectedChat();
  const hasDetail =
    loc.pathname.split("/").filter(Boolean).length >= 3 ||
    (section === "chats" && selectedId !== null);
  const showMainOnMobile = section === null || hasDetail;
  const showListOnMobile = section !== null && !showMainOnMobile;

  return (
    // Pin the shell to the viewport with position:fixed + inset:0 so it is
    // exactly the viewport regardless of the html/body/#root height chain or any
    // Tailwind class generation — page-scroll is structurally impossible.
    <CallProvider>
    <div className="flex flex-col overflow-hidden brand-mesh" style={{ position: "fixed", inset: 0 }}>
      <WsEventBridge />
      <TelemetryBridge />
      <CallUI />
      <VerifyEmailBanner />
      <MfaRequiredBanner />
      <TopNavbar unread={unread} onOpenNotifs={() => setNotifOpen(true)} />

      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2">
        <Rail section={railSection} variant="side" className="hidden md:flex" badges={railBadges} />
        {section && (
          <aside
            className={`glass min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-2xl md:my-0 ${
              // Mail is the one section whose main pane is itself two columns
              // (message list + reading pane, see MailLayout), so its folder
              // column is narrower — three panes at 24rem each leaves the mail
              // itself nothing to be read in. Every other section fills the pane.
              section === "mail" ? "md:w-72 lg:w-80" : "md:w-80 lg:w-96"
            } ${showListOnMobile ? "flex" : "hidden"} md:flex`}
          >
            {section === "mail" && <MailFolders />}
            {section === "chats" && <ChatsList />}
            {section === "tasks" && <TasksList />}
            {section === "channels" && <ChannelsList />}
            {section === "members" && <MembersList />}
          </aside>
        )}
        <main
          className={`glass min-w-0 flex-1 overflow-hidden rounded-2xl ${
            showMainOnMobile ? "block" : "hidden"
          } md:block`}
        >
          <Outlet />
        </main>
      </div>

      {/* Phone-only bottom tab bar; the side rail above handles md+. */}
      <Rail section={railSection} variant="bottom" className="mx-2 mb-2 md:hidden" badges={railBadges} />

      <NotificationsPanel
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        notifications={notifications}
      />
    </div>
    </CallProvider>
  );
}

/**
 * Thin banner prompting an unverified user to confirm their email. Only shows
 * when the session user's emailVerified is explicitly false (undefined — an
 * older response — is treated as verified so the banner never false-fires).
 * Dismissible for the session; "Resend" re-issues the link.
 */
function VerifyEmailBanner() {
  const user = useSession((s) => s.user);
  const { api } = useRuntime();
  const [dismissed, setDismissed] = useState(false);
  const [sent, setSent] = useState(false);

  if (!user || user.emailVerified !== false || dismissed) return null;

  const resend = async () => {
    setSent(true);
    await api.resendVerification().catch(() => {});
    toast.success("Verification email sent — check your inbox.");
  };

  return (
    <div className="flex items-center justify-center gap-3 border-b border-warning/30 bg-warning/15 px-4 py-2 text-center text-[13px] text-fg">
      <MailWarning size={15} className="shrink-0 text-warning" aria-hidden />
      <span>Verify your email address to fully secure your account.</span>
      <button
        onClick={resend}
        disabled={sent}
        className="font-semibold text-accent hover:underline disabled:opacity-60"
      >
        {sent ? "Sent ✓" : "Resend email"}
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="ml-1 text-muted hover:text-fg"
        aria-label="Dismiss"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

/** Mirrors VerifyEmailBanner above — same shape, same only-a-dismissable-strip
 *  posture. Shown only to an org_admin whose org has turned on mandatory MFA
 *  and who has not yet enrolled; once the grace deadline passes, login itself
 *  blocks them into enrollment instead (see mfa_service.mfa_gate), so this
 *  banner is only ever seen during the warning window. */
function MfaRequiredBanner() {
  const user = useSession((s) => s.user);
  const nav = useNavigate();
  const [dismissed, setDismissed] = useState(false);

  if (
    !user ||
    !user.orgRequireMfaForAdmins ||
    user.mfaEnrolled ||
    !user.roles.includes("org_admin") ||
    dismissed
  )
    return null;

  const deadline = user.orgMfaGracePeriodEndsAt
    ? new Date(user.orgMfaGracePeriodEndsAt).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div className="flex items-center justify-center gap-3 border-b border-warning/30 bg-warning/15 px-4 py-2 text-center text-[13px] text-fg">
      <ShieldAlert size={15} className="shrink-0 text-warning" aria-hidden />
      <span>
        Your workspace requires two-factor authentication for admins
        {deadline ? ` — enable it by ${deadline}` : ""}.
      </span>
      <button
        onClick={() => nav("/app/settings/security")}
        className="font-semibold text-accent hover:underline"
      >
        Enable now
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="ml-1 text-muted hover:text-fg"
        aria-label="Dismiss"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
