import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CheckCheck, Bell, Hash } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import type { NotificationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { decrementUnreadCount, refreshUnreadCount } from "../lib/unreadNotificationCount";
import { Sheet } from "./Modal";

export function NotificationsPanel({
  open,
  onClose,
  notifications,
}: {
  open: boolean;
  onClose: () => void;
  notifications: NotificationDTO[];
}) {
  const { t, i18n } = useTranslation("shell");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [showRead, setShowRead] = useState(false);

  // Collapse the history again whenever the panel closes, so reopening always
  // answers "what's new?" rather than resuming a browse session.
  useEffect(() => {
    if (!open) setShowRead(false);
  }, [open]);

  // Mark everything read when the panel CLOSES — not when it opens.
  //
  // Opening was the wrong moment, and it made the panel useless for the one
  // thing it is for. The effect flipped every row to `read` on open, `unread`
  // emptied on the same render, and the user was left staring at "You're all
  // caught up": the notifications they opened the bell to read had moved into
  // "Show read" before they could read them.
  //
  // Closing is the honest moment to call them seen — the rows were on screen
  // for as long as the panel was open — and the bell badge (AppShell counts
  // !read) still clears without the user having to touch each row.
  //
  // The cleanup reads the CACHE rather than the `notifications` prop: the prop
  // is captured when the effect runs (panel open) and would miss anything that
  // arrived while it was open. Best-effort + idempotent, as before.
  useEffect(() => {
    if (!open) return;
    return () => {
      const current = qc.getQueryData<NotificationDTO[]>(qk.notifications) ?? [];
      const unreadCount = current.filter((n) => !n.read).length;
      if (unreadCount === 0) return;
      // The list is capped at the 200 newest, so this can undercount a deep
      // backlog; the refresh once read-all settles puts the badge right.
      decrementUnreadCount(qc, unreadCount);
      void api
        .readAllNotifications()
        .catch(() => {})
        .then(() => refreshUnreadCount(qc));
      qc.setQueryData<NotificationDTO[]>(qk.notifications, (prev) =>
        (prev ?? []).map((n) => (n.read ? n : { ...n, read: true })),
      );
    };
  }, [open, api, qc]);

  const markRead = async (id: string) => {
    // Flip the row and lower the badge BEFORE the request, not after it. If the
    // panel closes while the request is out, the close handler's read-all counts
    // the unread rows in the cache — this one has to be read there already, or
    // it comes off the badge twice.
    let flipped = 0;
    qc.setQueryData<NotificationDTO[]>(qk.notifications, (prev) =>
      (prev ?? []).map((n) => {
        if (n.id !== id || n.read) return n;
        flipped++;
        return { ...n, read: true };
      }),
    );
    decrementUnreadCount(qc, flipped);

    const failed = await api.markNotificationRead(id).then(
      () => false,
      () => true,
    );
    // The server has the last word. Failed: it still holds the row unread, so
    // refetch the list as well and the row comes back; otherwise just the count.
    void (failed ? qc.invalidateQueries({ queryKey: qk.notifications }) : refreshUnreadCount(qc));
  };

  // Read notifications are HISTORY, not news. Showing them by default meant the
  // panel looked identical after every reopen — "all my notifications came
  // back, including the ones I'd already read" — because nothing ever left it.
  // They stay one click away rather than being thrown out.
  const unread = notifications.filter((n) => !n.read);
  const shown = showRead ? notifications : unread;
  const readCount = notifications.length - unread.length;

  return (
    <Sheet open={open} onClose={onClose} title={t("notifications.title")}>
      {shown.length === 0 ? (
        <EmptyState
          icon={<Bell size={22} />}
          title={showRead ? t("notifications.empty.noneYet") : t("notifications.empty.allCaughtUp")}
          hint={
            showRead
              ? t("notifications.empty.hintTaskUpdates")
              : readCount > 0
                ? t("notifications.empty.hintNothingUnread")
                : t("notifications.empty.hintTaskUpdates")
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((n) => (
            <li
              key={n.id}
              className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${
                n.read ? "border-border opacity-70" : "border-accent/30 bg-accent-soft/50"
              }`}
            >
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                {/* A channel invitation under a double-tick reads as "your task
                    was completed", which is the opposite of what happened. */}
                {n.kind === "CHANNEL_ADDED" ? <Hash size={16} /> : <CheckCheck size={16} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">{n.text}</p>
                <p className="mt-0.5 text-xs text-muted">{new Date(n.createdAt).toLocaleString(i18n.language)}</p>
              </div>
              {!n.read && (
                <button className="text-xs font-medium text-accent hover:underline" onClick={() => markRead(n.id)}>
                  {t("notifications.row.markRead")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {readCount > 0 && (
        <button
          onClick={() => setShowRead((v) => !v)}
          className="mt-3 w-full rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {showRead ? t("notifications.toggleHideRead") : t("notifications.toggleShowRead", { count: readCount })}
        </button>
      )}
    </Sheet>
  );
}
