import { useState } from 'react';
import { Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { isMfaPending } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';

/**
 * Switch the active organization — mobile twin of `useSwitchOrg`
 * (packages/app/src/features/OrgSwitcher.tsx). Reuses the same
 * `api.switchOrg` call and cache-clear; drops two web-only pieces that don't
 * translate:
 *  - `broadcastSession` (a `BroadcastChannel` cross-TAB sync) — mobile has no
 *    other tabs to sync.
 *  - the MFA-pending redirect to `/mfa-challenge` — that screen lives in
 *    `AuthNavigator`, a sibling navigator tree `RootNavigator` only mounts
 *    while signed OUT (see RootNavigator.tsx), and a mid-session org switch
 *    never flips `session.status` away from "authed" (the current session is
 *    deliberately left untouched when the target org needs MFA — see the web
 *    hook's own comment). Reaching a screen in the other tree from here would
 *    need restructuring that navigator split, which is out of scope for a
 *    presentation-layer change. An org that requires MFA this device hasn't
 *    enrolled therefore surfaces as a clear, honest error instead of a silent
 *    dead end or a fake success.
 */
export function useSwitchOrg() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const setSession = useSession((s) => s.setSession);
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);

  const switchOrg = async (orgId: string) => {
    setSwitchingOrgId(orgId);
    try {
      const result = await api.switchOrg(orgId);
      if (isMfaPending(result)) {
        Alert.alert(
          'Extra verification required',
          'This organization requires multi-factor authentication that isn’t set up on this device yet. Switch from the BlissWork web app to complete it.',
        );
        return;
      }
      setSession({ user: result.user, accessToken: result.accessToken, expiresIn: result.expiresIn });
      qc.clear(); // every cached query is scoped to the previous org
    } catch {
      Alert.alert("Couldn't switch organization", 'Please try again.');
    } finally {
      setSwitchingOrgId(null);
    }
  };

  return { switchOrg, switchingOrgId };
}
