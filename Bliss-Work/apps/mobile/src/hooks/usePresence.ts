import { useMemo } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/**
 * Mobile-local twin of `usePresence` (packages/app/src/lib/usePresence.ts) —
 * same design (scoped `POST /presence/query` poll, reconciled into one shared
 * cache that live `presence.*` WS events also patch, `GET /presence`'s
 * whole-org scan never called), rewritten against this file's own `qk`
 * instead of importing the original: that file imports `qk` from
 * `queryBridge.tsx`, which pulls in `react-router-dom` at module scope and
 * cannot be required in a React Native bundle. See `useWsBridge.ts` for the
 * live-event half of this — it patches the same `qk.presence` cache key.
 */
const MAX_IDS_PER_QUERY = 500;
const PRESENCE_POLL_MS = 20_000;

function chunk(ids: string[], size: number): string[][] {
  if (ids.length <= size) return ids.length ? [ids] : [];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Presence for a specific, bounded set of people — pass the ids on screen. */
export function usePresence(userIds: readonly string[]): Set<string> {
  const { api } = useRuntime();
  const qc = useQueryClient();

  const ids = useMemo(
    () => Array.from(new Set(userIds)).sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the joined string IS the identity
    [userIds.join(' ')],
  );
  const batches = useMemo(() => chunk(ids, MAX_IDS_PER_QUERY), [ids]);

  useQueries({
    queries: batches.map((batch) => ({
      queryKey: [...qk.presence, 'of', batch.join(',')],
      refetchInterval: PRESENCE_POLL_MS,
      queryFn: async () => {
        const online = await api.presenceOf(batch);
        qc.setQueryData<string[]>(qk.presence, (prev) => {
          const asked = new Set(batch);
          const untouched = (prev ?? []).filter((id) => !asked.has(id));
          return [...untouched, ...online];
        });
        return online;
      },
    })),
  });

  const { data: online = [] } = useQuery<string[]>({
    queryKey: qk.presence,
    queryFn: () => qc.getQueryData<string[]>(qk.presence) ?? [],
    staleTime: Infinity,
  });

  return useMemo(() => new Set(online), [online]);
}
