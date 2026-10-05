import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/** Extra mail lists hang off `qk.mailInbox` so the single `MailDelivered`
 *  invalidation in useWsBridge (prefix match) refreshes every folder. */
export const mailBoxKeys = {
  deleted: [...qk.mailInbox, 'deleted'] as const,
  drafts: [...qk.mailInbox, 'drafts'] as const,
};

/** Deleted Items — the same feed with its visibility predicate inverted. Only fetched while that folder is open. */
export function useDeletedMail(enabled: boolean) {
  const { api } = useRuntime();
  return useInfiniteQuery({
    queryKey: mailBoxKeys.deleted,
    queryFn: ({ pageParam }) => api.inbox(pageParam as string | undefined, 50, undefined, ['MAIL'], true),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
  });
}

/** Drafts have their own listing (a draft is in nobody's feed). */
export function useMailDrafts(enabled: boolean) {
  const { api } = useRuntime();
  return useQuery({ queryKey: mailBoxKeys.drafts, queryFn: () => api.mailDrafts(), enabled });
}

/** Delete = hide the caller's own copy only (`ignoreInboxItem('MAIL')`). */
export function useDeleteMail() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (refId: string) => api.ignoreInboxItem('MAIL', refId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mailInbox }),
  });
}

export function useRestoreMail() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (refId: string) => api.restoreMail(refId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mailInbox }),
  });
}

export function useDiscardDraft() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mailId: string) => api.discardMailDraft(mailId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.mailInbox }),
  });
}
