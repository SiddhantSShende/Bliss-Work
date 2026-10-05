import { useQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from '../hooks/queryKeys';

export interface CallerProfile {
  name: string;
  username?: string;
  avatarUrl?: string | null;
}

/**
 * Who is calling, as the real directory knows them: full name, @username and
 * profile photo for `userId`. Shares the `qk.directory` cache with the rest of
 * the app (the CallProvider has usually already warmed it to resolve the name),
 * so an incoming ring never triggers a second directory download — and the
 * photo itself is a `data:` URI inside that record, so there is no image fetch
 * to repeat. `fallbackName` (the name from the ring frame) shows until the
 * directory answers, and if `userId` is unknown there is no photo, in which
 * case the caller renders the app's normal initials avatar.
 */
export function useCallerProfile(userId: string | undefined, fallbackName: string): CallerProfile {
  const { api } = useRuntime();
  const { data } = useQuery({
    queryKey: qk.directory,
    queryFn: () => api.directory(),
    enabled: !!userId,
    staleTime: 5 * 60_000,
  });
  const u = userId ? data?.find((x) => x.id === userId) : undefined;
  return { name: u?.displayName || fallbackName, username: u?.username, avatarUrl: u?.avatarUrl };
}
