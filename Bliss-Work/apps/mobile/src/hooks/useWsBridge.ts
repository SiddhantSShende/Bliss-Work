import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { handleEvent } from './wsBridgeEvents';

/**
 * Mobile's own live-update bridge: subscribes to the already-connected `ws`
 * (see `useConnectEventBridge`, called alongside this from `AppTabs`) via a
 * single `ws.on(handler)` — same entry point web's `WsEventBridge` uses — and
 * invalidates the matching query key per event, so screens refetch instead of
 * polling.
 *
 * Deliberately NOT a port of `WsEventBridge` itself
 * (packages/app/src/lib/queryBridge.tsx): that component imports
 * `react-router-dom`'s `useNavigate` at module scope (for call-ring
 * navigation) and reads `window.location`, neither of which exists in React
 * Native. This covers the events mobile's own screens actually render;
 * `WsEventBridge` covers strictly more (full call-lifecycle navigation, the
 * unified inbox) because it backs strictly more surfaces.
 */
export function useWsBridge(): void {
  const { ws } = useRuntime();
  const qc = useQueryClient();
  // The socket is authenticated as ONE org membership, so it follows the active
  // org like web's WsEventBridge: re-dialled under the new token on an org switch,
  // and closed when this unmounts (sign-out). Before, nothing ever closed it —
  // a signed-out user kept showing as Online, and the next user's connect() was a
  // no-op on the previous user's live socket.
  const orgId = useSession((s) => s.user?.orgId);

  useEffect(() => {
    void ws.connect(); // a no-op when useConnectEventBridge already opened it
    const off = ws.on((e) => handleEvent(e, qc));
    return () => {
      off();
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, orgId]);
}
