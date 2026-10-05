import { useSession } from '@taskboard/app/store/session';

/**
 * Whether the signed-in user is a workspace admin. The role model has exactly
 * two roles (`org_admin` | `member`) — there is no separate "owner" role
 * (see `Role` in @taskboard/shared); whoever created the workspace is an
 * `org_admin`, so Owner and Admin are the same permission here.
 *
 * This only decides what the UI shows. The real control is server-side: every
 * admin endpoint (/auth/members*, /auth/audit, /telemetry/members/{other})
 * refuses a non-admin regardless of what the client renders.
 */
export function useIsOrgAdmin(): boolean {
  return useSession((s) => s.user?.roles.includes('org_admin') ?? false);
}
