import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MailWarning } from "lucide-react";
import { toast } from "sonner";
import type { NotificationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk, WsEventBridge } from "../lib/queryBridge";
import { CallProvider } from "../lib/useCall";
import { CallUI } from "../features/CallUI";
import { NotificationsPanel } from "../features/NotificationsPanel";
import { TopNavbar } from "../features/TopNavbar";
import { Rail } from "./Rail";
import { ChatsList } from "./ChatsList";
import { TasksList } from "./TasksList";
import { ChannelsList } from "./ChannelsList";
import { MembersList } from "./MembersList";
import { InboxPeopleList } from "./InboxPeopleList";

export function AppShell() {
  const { api } = useRuntime();
  const loc = useLocation();
  const [notifOpen, setNotifOpen] = useState(false);

  const { data: notifications = [] } = useQuery({
    queryKey: qk.notifications,
    queryFn: () => api.notifications(),
  });
  const unread = notifications.filter((n: NotificationDTO) => !n.read).length;

  // Per-section alert counts for the left rail. Inbox shows the summed unread
  // across counterparties; Tasks surfaces unread task notifications so a new
  // ack/complete/ignore/left is visible without opening the bell.
  const { data: inboxPeers = [] } = useQuery({
    queryKey: qk.inboxPeers,
    queryFn: () => api.inboxPeers(),
  });
  const inboxUnread = inboxPeers.reduce((sum, p) => sum + (p.unreadCount || 0), 0);
  const railBadges: Record<string, number> = { inbox: inboxUnread, tasks: unread };

  // inbox/chats/tasks/channels drive the contextual list pane; utility pages
  // (search/invite/profile) render full-width with no list pane.
  const section = loc.pathname.startsWith("/app/inbox")
    ? "inbox"
    : loc.pathname.startsWith("/app/tasks")
      ? "tasks"
      : loc.pathname.startsWith("/app/channels")
        ? "channels"
        : loc.pathname.startsWith("/app/members")
          ? "members"
          : loc.pathname.startsWith("/app/chats")
            ? "chats"
            : null;

  // On phones we only have room for ONE pane. A path with a third segment
  // (/app/chats/:id, /app/tasks/:view) is a "detail" → show the main content;
  // a bare section index (/app/chats, /app/members) → show the list pane.
  // members has no detail view of its own, so it always stays on the list.
  // md+ shows both panes side by side, so these flags are ignored there.
  const hasDetail = loc.pathname.split("/").filter(Boolean).length >= 3;
  const showMainOnMobile = section === null || (section !== "members" && hasDetail);
  const showListOnMobile = section !== null && !showMainOnMobile;

  return (
    // Pin the shell to the viewport with position:fixed + inset:0 so it is
    // exactly the viewport regardless of the html/body/#root height chain or any
    // Tailwind class generation — page-scroll is structurally impossible.
    <CallProvider>
    <div className="flex flex-col overflow-hidden brand-mesh" style={{ position: "fixed", inset: 0 }}>
      <WsEventBridge />
      <CallUI />
      <VerifyEmailBanner />
      <TopNavbar unread={unread} onOpenNotifs={() => setNotifOpen(true)} />

      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2">
        <Rail section={section} variant="side" className="hidden md:flex" badges={railBadges} />
        {section && (
          <aside
            className={`glass min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-2xl md:my-0 md:w-80 lg:w-96 ${
              showListOnMobile ? "flex" : "hidden"
            } md:flex`}
          >
            {section === "inbox" && <InboxPeopleList />}
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
      <Rail section={section} variant="bottom" className="mx-2 mb-2 md:hidden" badges={railBadges} />

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
