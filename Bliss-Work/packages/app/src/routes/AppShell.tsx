import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MailWarning, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { NotificationClickBridge } from "../features/NotificationClickBridge";
import { qk, WsEventBridge } from "../lib/queryBridge";
import { listSectionOf, railSectionOf } from "../lib/section";
import { useSelectedChat } from "../lib/selectedChat";
import { useSyncUnreadCounts } from "../lib/useSyncUnreadCounts";
import { TelemetryBridge } from "../lib/telemetry";
import { CallProvider } from "../lib/useCall";
import { CallUI } from "../features/CallUI";
import { NotificationsPanel } from "../features/NotificationsPanel";
import { MobileNavDrawer } from "../features/MobileNavDrawer";
import { TopNavbar } from "../features/TopNavbar";
import { Rail } from "./Rail";
import { ChatsList } from "./ChatsList";
import { TasksList } from "./TasksList";
import { ChannelsList } from "./ChannelsList";
import { MembersList } from "./MembersList";
import { MailFolders } from "./MailFolders";
import { mergeNotificationFeeds } from "../lib/notificationPages";
import { useNotificationPages } from "../lib/useCursorPagination";

/** Sections whose list pane holds conversation/person rows rather than
 *  navigation labels — see the width comment on the <aside> below. */
const ROW_LIST_SECTIONS = new Set<string>(["chats", "channels", "members"]);

/** Width of the secondary-navigation pane from lg up: one value for every
 *  section except Mail. Chat's pane was 280px (md:w-[280px] below); 280 × 1.5 =
 *  420px. The main pane (flex-1) takes the rest. Literal class so Tailwind can
 *  see it. */
const LIST_PANE_LG_WIDTH = "lg:w-[420px]";

/** Mail's folder pane from lg up: half of LIST_PANE_LG_WIDTH. It holds only
 *  five short folder labels, so the rest of 420px was dead space. */
const MAIL_PANE_LG_WIDTH = "lg:w-[210px]";

export function AppShell() {
  const { api } = useRuntime();
  const loc = useLocation();
  const [notifOpen, setNotifOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Per-section alert counts for the left rail, from two lightweight
  // server-computed endpoints instead of the full conversations/channels/
  // inbox-peers/notifications lists — see docs/API-LAZY-LOADING-AUDIT.md
  // D1/S3. Each section's own list pane (ChatsList/ChannelsList/MailFolders
  // below) still fetches its full data itself, the first time that section
  // is actually opened; before this change AppShell primed that same cache
  // entry eagerly on every mount, which this deliberately no longer does —
  // the first-open of a section now costs a real fetch instead of a cache
  // hit, in exchange for every OTHER mount (every section never opened this
  // session) no longer paying for the full lists at all.
  //
  // Both queries are invalidated by the same WS events that used to keep the
  // full-list-based badges live (queryBridge's message.created/
  // channel.message.created/notification.created handlers already invalidate
  // qk.conversations/qk.channels/qk.notifications; those handlers now also
  // invalidate these two keys — see queryBridge.tsx), so real-time badge
  // updates are unchanged.
  const { data: unreadCounts } = useQuery({
    queryKey: qk.unreadCounts,
    queryFn: () => api.unreadCounts(),
  });
  useSyncUnreadCounts();
  const { data: notifUnread } = useQuery({
    queryKey: qk.notificationsUnreadCount,
    queryFn: () => api.notificationsUnreadCount(),
  });
  const unread = notifUnread?.unreadCount ?? 0;

  // The bell's own list — unlike the badge count above, this genuinely only
  // needs to exist once the panel is actually opened.
  // Two server-filtered feeds that the panel shows together as the notification
  // history: unread (first, what the badge counts) and read. Both load on open so
  // neither can hide the other behind its own pages.
  const unreadPages = useNotificationPages(api, notifOpen, false);
  const readPages = useNotificationPages(api, notifOpen, true);
  const notifications = mergeNotificationFeeds(unreadPages.data, readPages.data);

  const railBadges: Record<string, number> = {
    mail: unreadCounts?.inboxPeers ?? 0,
    tasks: unread,
    chats: unreadCounts?.conversations ?? 0,
    channels: unreadCounts?.channels ?? 0,
  };

  // mail/chats/tasks/channels drive the contextual list pane; utility pages
  // (search/invite/profile) render full-width with no list pane. Org is
  // full-width but IS a rail item, so the rail gets its own highlight-only
  // key. Both live in lib/section.ts, which telemetry shares — three copies
  // of this prefix chain is three chances for a new route to be classified
  // inconsistently.
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
      <NotificationClickBridge />
      <TelemetryBridge />
      <CallUI />
      <VerifyEmailBanner />
      <MfaRequiredBanner />
      <TopNavbar unread={unread} onOpenNotifs={() => setNotifOpen(true)} onOpenDrawer={() => setDrawerOpen(true)} />

      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2">
        <Rail section={railSection} variant="side" className="hidden md:flex" badges={railBadges} />
        {section && (
          <aside
            // Pure navigation panes (Tasks categories, Mail folders) are short
            // labels + a count and fit 208px. Chats/Channels/Members rows carry
            // an avatar, a name, a timestamp, a preview, an unread badge and a
            // ⋮ menu — below ~280px the name collapses to "J…" — so those get
            // a wider pane. Both are md+ only; below md the pane is full width,
            // and from lg up every section shares LIST_PANE_LG_WIDTH.
            className={`glass min-h-0 w-full shrink-0 flex-col overflow-hidden rounded-2xl md:my-0 ${
              ROW_LIST_SECTIONS.has(section) ? "md:w-[280px]" : "md:w-[208px]"
            } ${section === "mail" ? MAIL_PANE_LG_WIDTH : LIST_PANE_LG_WIDTH} ${showListOnMobile ? "flex" : "hidden"} md:flex`}
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
      <Rail
        section={railSection}
        variant="bottom"
        className="mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
        badges={railBadges}
      />

      <NotificationsPanel
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        notifications={notifications}
        unreadCount={unread}
        onRetry={() => {
          void unreadPages.refetch();
          void readPages.refetch();
        }}
        unreadFeed={{
          loading: unreadPages.isPending,
          failed: unreadPages.isError,
          hasNextPage: unreadPages.hasNextPage,
          isFetchingNextPage: unreadPages.isFetchingNextPage,
          loadMore: () => void unreadPages.fetchNextPage(),
        }}
        readFeed={{
          loading: readPages.isPending,
          failed: readPages.isError,
          hasNextPage: readPages.hasNextPage,
          isFetchingNextPage: readPages.isFetchingNextPage,
          loadMore: () => void readPages.fetchNextPage(),
        }}
      />
      <MobileNavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        section={railSection}
        badges={railBadges}
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
  const { t } = useTranslation(["appShell", "common"]);
  const user = useSession((s) => s.user);
  const { api } = useRuntime();
  const [dismissed, setDismissed] = useState(false);
  const [sent, setSent] = useState(false);

  if (!user || user.emailVerified !== false || dismissed) return null;

  const resend = async () => {
    setSent(true);
    await api.resendVerification().catch(() => {});
    toast.success(t("appShell:verifyEmail.resentToast"));
  };

  return (
    <div className="flex items-center justify-center gap-3 border-b border-warning/30 bg-warning/15 px-4 py-2 text-center text-[13px] text-fg">
      <MailWarning size={15} className="shrink-0 text-warning" aria-hidden />
      <span>{t("appShell:verifyEmail.message")}</span>
      <button
        onClick={resend}
        disabled={sent}
        className="font-semibold text-accent hover:underline disabled:opacity-60"
      >
        {sent ? t("appShell:verifyEmail.resendSent") : t("appShell:verifyEmail.resend")}
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="ml-1 text-muted hover:text-fg"
        aria-label={t("common:buttons.dismiss")}
        title={t("common:buttons.dismiss")}
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
  const { t, i18n } = useTranslation(["appShell", "common"]);
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

  // Follows the in-app selected locale (i18n.language) rather than the
  // browser's own locale, so this reads consistently with the rest of the UI.
  const deadline = user.orgMfaGracePeriodEndsAt
    ? new Date(user.orgMfaGracePeriodEndsAt).toLocaleDateString(i18n.language, {
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div className="flex items-center justify-center gap-3 border-b border-warning/30 bg-warning/15 px-4 py-2 text-center text-[13px] text-fg">
      <ShieldAlert size={15} className="shrink-0 text-warning" aria-hidden />
      <span>
        {deadline
          ? t("appShell:mfaRequired.messageWithDeadline", { deadline })
          : t("appShell:mfaRequired.messageNoDeadline")}
      </span>
      <button
        onClick={() => nav("/app/settings/security")}
        className="font-semibold text-accent hover:underline"
      >
        {t("appShell:mfaRequired.enableNow")}
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="ml-1 text-muted hover:text-fg"
        aria-label={t("common:buttons.dismiss")}
        title={t("common:buttons.dismiss")}
      >
        ✕
      </button>
    </div>
  );
}
