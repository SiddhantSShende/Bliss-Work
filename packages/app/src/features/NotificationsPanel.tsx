import { useEffect } from "react";
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

  return (
    <Sheet open={open} onClose={onClose} title="Notifications">
      {notifications.length === 0 ? (
        <EmptyState icon={<Bell size={22} />} title="No notifications yet" hint="Task updates will show up here." />
      ) : (
        <ul className="flex flex-col gap-2">
          {notifications.map((n) => (
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
    </Sheet>
  );
}
