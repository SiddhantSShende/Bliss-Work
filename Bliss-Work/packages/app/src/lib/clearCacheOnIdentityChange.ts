import type { QueryClient } from "@tanstack/react-query";
import { useSession } from "../store/session";

/** Who the cache belongs to: a user, in an org. Null when nobody is signed in. */
function identityOf(state: { user: { id: string; orgId: string } | null }): string | null {
  return state.user ? `${state.user.id}:${state.user.orgId}` : null;
}

/**
 * Empty the query cache whenever the session stops belonging to the person and
 * org that filled it: sign-out, a session that died, a different user signing in,
 * an org switch — including one another tab made and this tab adopted.
 *
 * Query keys carry no user or org id, so without this the next session's first
 * paint is the previous one's data (conversations, tasks, unread counts) until a
 * refetch replaces it; the SPA signs out with a client-side navigation, not a reload.
 *
 * Going from signed out to signed in does not clear: the cache was emptied when
 * the last session ended, and a page load that restores one starts empty anyway.
 * A token refresh or a profile edit keeps the same user and org, so keeps the cache.
 *
 * Returns the unsubscribe function.
 */
export function clearCacheOnIdentityChange(queryClient: QueryClient, store = useSession): () => void {
  let current = identityOf(store.getState());
  return store.subscribe((state) => {
    const next = identityOf(state);
    if (next === current) return;
    const hadSession = current !== null;
    current = next;
    if (hadSession) queryClient.clear();
  });
}
