import { useQuery } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from './queryKeys';

/** Every organization this identity belongs to — backs the Home org-switcher
 *  card/sheet. Mirrors web's `OrgSwitcher` data (`api.myOrgs()`). */
export function useMyOrgs() {
  const { api } = useRuntime();
  return useQuery({ queryKey: qk.myOrgs, queryFn: () => api.myOrgs() });
}
