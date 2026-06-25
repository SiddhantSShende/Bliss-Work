import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { NotificationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk, WsEventBridge } from "../lib/queryBridge";
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
    <div className="flex flex-col overflow-hidden brand-mesh" style={{ position: "fixed", inset: 0 }}>
      <WsEventBridge />
      <TopNavbar unread={unread} onOpenNotifs={() => setNotifOpen(true)} />

      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden p-2">
        <Rail section={section} variant="side" className="hidden md:flex" />
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
      <Rail section={section} variant="bottom" className="mx-2 mb-2 md:hidden" />

      <NotificationsPanel
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        notifications={notifications}
      />
    </div>
  );
}
