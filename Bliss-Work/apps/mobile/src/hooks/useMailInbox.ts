import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/** Mail-kind rows from the unified inbox feed — read-first list, per the
 *  plan's lighter tier for Mail (no compose/reply in this pass). */
export function useMailInbox() {
  const { api } = useRuntime();
  return useInfiniteQuery({
    queryKey: qk.mailInbox,
    queryFn: ({ pageParam }) => api.inbox(pageParam as string | undefined, 50, undefined, ['MAIL']),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useMailDetail(mailId: string | undefined) {
  const { api } = useRuntime();
  return useQuery({
    queryKey: qk.mailDetail(mailId ?? ''),
    queryFn: () => api.mail(mailId!),
    enabled: Boolean(mailId),
  });
}

export function useMarkMailRead() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mailId: string) => api.readMail(mailId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mailInbox }),
  });
}
