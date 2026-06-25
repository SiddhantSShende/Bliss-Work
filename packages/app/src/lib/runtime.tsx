import { createContext, useContext, useMemo, useRef } from "react";
import { ApiClient, WsClient } from "@taskboard/shared";
import type { PlatformConfig, RtcTransport } from "../platform";
import { useSession } from "../store/session";
import { refreshSession } from "./refresh";

interface Runtime {
  config: PlatformConfig;
  api: ApiClient;
  ws: WsClient;
  /** Unified rtc.* signaling transport (web = WsClient, Electron = IPC bridge). */
  rtc: RtcTransport;
  /** Whether file transfer / rtc signaling is reachable on this platform. */
  rtcAvailable: boolean;
}

const RuntimeCtx = createContext<Runtime | null>(null);

export function RuntimeProvider({
  config,
  children,
}: {
  config: PlatformConfig;
  children: React.ReactNode;
}) {
  // Always read the freshest token from the store via a ref-less getter.
  const tokenRef = useRef<() => string | null>(() => useSession.getState().accessToken);

  const runtime = useMemo<Runtime>(() => {
    const getToken = () => useSession.getState().accessToken;

    // Single-flight (shared with the bootstrap) so a WS re-auth can't race the
    // page-load refresh and trip the rotating-token reuse detection.
    const refresh = async (): Promise<string> => {
      const session = await refreshSession(config.authBase, config.persistToken);
      if (!session) throw new Error("refresh failed");
      return session.accessToken;
    };

    // ws-gateway serves both the socket (/ws) and the presence HTTP endpoint;
    // derive its HTTP base from the configured WS url (ws://host/ws → http://host).
    const presenceBase = config.wsUrl.replace(/^ws/, "http").replace(/\/ws\/?$/, "");

    const api = new ApiClient({
      authBase: config.authBase,
      taskBase: config.taskBase,
      messagingBase: config.messagingBase,
      notificationBase: config.notificationBase,
      presenceBase,
      getToken,
      // Auto-recover from an expired access token: refresh (single-flight,
      // shared with bootstrap + WS) and let req() retry. null ⇒ refresh failed.
      refreshToken: () =>
        refreshSession(config.authBase, config.persistToken).then(
          (s) => s?.accessToken ?? null,
        ),
    });

    const ws = new WsClient({
      url: config.wsUrl,
      getToken: () => getToken() ?? "",
      refreshToken: refresh,
    });

    // Web signals over the renderer's own socket; Electron over the ws-process
    // IPC bridge (config.rtc). rtcAvailable gates the file-transfer UI so the
    // attach button only appears where a transport actually exists.
    const rtc: RtcTransport = config.rtc ?? {
      sendFrame: (f) => ws.sendFrame(f),
      onControl: (cb) => ws.onControl(cb),
    };
    const rtcAvailable = config.rtc ? true : !config.eventSource;

    return { config, api, ws, rtc, rtcAvailable };
     
  }, [config]);

  // keep ref in sync (used by callers that need a stable token getter)
  tokenRef.current = () => useSession.getState().accessToken;

  return <RuntimeCtx.Provider value={runtime}>{children}</RuntimeCtx.Provider>;
}

export function useRuntime(): Runtime {
  const r = useContext(RuntimeCtx);
  if (!r) throw new Error("useRuntime outside RuntimeProvider");
  return r;
}
