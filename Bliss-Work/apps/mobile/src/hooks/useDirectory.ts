import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { matchUser } from '@taskboard/app/lib/matchUser';
import { qk } from './queryKeys';

/** Org directory for the New Chat / Members people-picker, self-excluded and
 *  search-filtered — reuses the exact matching rule (`matchUser`) web's own
 *  pickers use, rather than re-deriving name/username/email matching here. */
export function useDirectory(query: string) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user);
  const { data: users = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
  });

  const all = useMemo(() => users.filter((u) => u.id !== me?.id), [users, me?.id]);
  const filtered = useMemo(() => all.filter((u) => matchUser(u, query)), [all, query]);

  return { all, filtered, isLoading, isError, error, refetch };
}
