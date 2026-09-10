import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/** Task/channel notifications — backs Home's bell icon badge. Marked read on
 *  close, not open, matching web's `NotificationsPanel` (deliberate: a
 *  glanced-at notification stays visible as unread until the panel closes). */
export function useNotifications() {
  const { api } = useRuntime();
  return useQuery({ queryKey: qk.notifications, queryFn: () => api.notifications() });
}

export function useReadAllNotifications() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.readAllNotifications(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.notifications }),
  });
}
