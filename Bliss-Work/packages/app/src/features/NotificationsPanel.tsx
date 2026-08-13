import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Bell } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import type { NotificationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
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
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [showRead, setShowRead] = useState(false);

  // Collapse the history again whenever the panel closes, so reopening always
  // answers "what's new?" rather than resuming a browse session.
  useEffect(() => {
    if (!open) setShowRead(false);
  }, [open]);

  // Auto-mark everything read when the panel opens — "seeing" the inbox counts
  // as reading it, so the bell badge (AppShell counts !read) clears on open.
  // The per-item "Mark read" button stays for parity. Best-effort + idempotent.
  useEffect(() => {
    if (!open || !notifications.some((n) => !n.read)) return;
    void api.readAllNotifications().catch(() => {});
    qc.setQueryData<NotificationDTO[]>(qk.notifications, (prev) =>
      (prev ?? []).map((n) => (n.read ? n : { ...n, read: true })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const markRead = async (id: string) => {
    await api.markNotificationRead(id).catch(() => {});
    qc.setQueryData<NotificationDTO[]>(qk.notifications, (prev) =>
      (prev ?? []).map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  };

  // Read notifications are HISTORY, not news. Showing them by default meant the
  // panel looked identical after every reopen — "all my notifications came
  // back, including the ones I'd already read" — because nothing ever left it.
  // They stay one click away rather than being thrown out.
  const unread = notifications.filter((n) => !n.read);
  const shown = showRead ? notifications : unread;
  const readCount = notifications.length - unread.length;

  return (
    <Sheet open={open} onClose={onClose} title="Notifications">
      {shown.length === 0 ? (
        <EmptyState
          icon={<Bell size={22} />}
          title={showRead ? "No notifications yet" : "You're all caught up"}
          hint={
            showRead
              ? "Task updates will show up here."
              : readCount > 0
                ? "Nothing unread. Earlier notifications are under “Show read”."
                : "Task updates will show up here."
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
                <CheckCheck size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">{n.text}</p>
                <p className="mt-0.5 text-xs text-muted">{new Date(n.createdAt).toLocaleString()}</p>
              </div>
              {!n.read && (
                <button className="text-xs font-medium text-accent hover:underline" onClick={() => markRead(n.id)}>
                  Mark read
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
          {showRead ? "Hide read" : `Show read (${readCount})`}
        </button>
      )}
    </Sheet>
  );
}
