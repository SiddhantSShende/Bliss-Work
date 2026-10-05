import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import type { MemberActivityDTO, MemberDTO } from '@taskboard/shared';
import { qk } from './queryKeys';

const ROSTER_POLL_MS = 60_000;

/**
 * The admin's view of the workspace: every membership (including suspended and
 * removed — `GET /auth/members`) plus the telemetry roster that says who is
 * online/idle/offline and when they were last seen (`GET /telemetry/members`).
 * Both endpoints are org_admin-only on the server; `enabled` merely stops a
 * non-admin client from making calls it is certain to be refused.
 *
 * Last seen comes from the roster rather than presence on purpose — see the
 * long note in web's MemberDetail.tsx: an open socket is not a person.
 */
export function useMemberRoster(enabled: boolean) {
  const { api } = useRuntime();
  const members = useQuery({ queryKey: qk.members, queryFn: () => api.listMembers(), enabled });
  const activity = useQuery({
    queryKey: qk.activityRoster,
    queryFn: () => api.memberActivity(),
    enabled,
    refetchInterval: ROSTER_POLL_MS,
  });
  const activityById = useMemo(() => {
    const m = new Map<string, MemberActivityDTO>();
    for (const a of activity.data ?? []) m.set(a.userId, a);
    return m;
  }, [activity.data]);
  return { members, activity, activityById };
}

export type { MemberDTO };
