import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { ApiClient, WsClient } from "@taskboard/shared";
import type { PlatformConfig, RtcTransport } from "../platform";
import { useSession } from "../store/session";
import { isSessionDead, refreshSession } from "./refresh";

// How long before the access token's real expiry to refresh it proactively.
// Comfortably inside the ~15min TTL so ordinary latency/clock drift can never
// push the refresh past the actual expiry, while not refreshing so early that
// the token loses most of its intended lifetime.
const PROACTIVE_REFRESH_BUFFER_MS = 60_000;

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
      const session = await refreshSession(config.authBase, config.persistToken, config.getRefreshToken);
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
      telemetryBase: config.telemetryBase,
      notificationBase: config.notificationBase,
      graphBase: config.graphBase,
      stickyBase: config.stickyBase,
      presenceBase,
      getToken,
      // Auto-recover from an expired access token: refresh (single-flight,
      // shared with bootstrap + WS) and let req() retry. null ⇒ refresh failed.
      refreshToken: () =>
        refreshSession(config.authBase, config.persistToken, config.getRefreshToken).then(
          (s) => s?.accessToken ?? null,
        ),
    });

    const ws = new WsClient({
      url: config.wsUrl,
      getToken: () => getToken() ?? "",
      refreshToken: refresh,
      // Same circuit breaker the HTTP refresh path uses. A revoked token family
      // already stopped refreshSession from touching the network; without this
      // the socket kept reconnecting on the empty token that left behind.
      isDead: isSessionDead,
    });

    // Web signals over the renderer's own socket; Electron over the ws-process
    // IPC bridge (config.rtc). rtcAvailable gates the file-transfer UI so the
    // attach button only appears where a transport actually exists.
    const rtc: RtcTransport = config.rtc ?? {
      sendFrame: (f) => ws.sendFrame(f),
      onControl: (cb) => ws.onControl(cb),
    };
    // Gate on what the question actually is — "do I have a transport?" — rather
    // than inferring the platform from `eventSource`, which is about the WS
    // living in the main process and has nothing to do with WebRTC. The old
    // `config.rtc ? true : !config.eventSource` was right only by coincidence:
    // any host that supplied eventSource without rtc would silently lose the
    // file-transfer UI with no error anywhere.
    const rtcAvailable = Boolean(config.rtc) || config.kind === "web";

    return { config, api, ws, rtc, rtcAvailable };
     
  }, [config]);

  // keep ref in sync (used by callers that need a stable token getter)
  tokenRef.current = () => useSession.getState().accessToken;

  // Refresh the access token BEFORE it expires instead of only reactively on
  // a 401 (ApiClient.req() and WsClient still do that too, as the fallback —
  // this just makes it rare in practice). refreshSession's setSession call
  // sets a fresh `expiresAt` on every success, which re-runs this effect and
  // re-arms it for the next cycle; a failed proactive attempt leaves
  // `expiresAt` unchanged and falls through to that reactive path when the
  // token actually expires, same as today.
  const status = useSession((s) => s.status);
  const expiresAt = useSession((s) => s.expiresAt);
  useEffect(() => {
    if (status !== "authed" || expiresAt == null) return;
    const delayMs = Math.max(expiresAt - Date.now() - PROACTIVE_REFRESH_BUFFER_MS, 5_000);
    const timer = setTimeout(() => {
      refreshSession(config.authBase, config.persistToken, config.getRefreshToken);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [status, expiresAt, config]);

  return <RuntimeCtx.Provider value={runtime}>{children}</RuntimeCtx.Provider>;
}

export function useRuntime(): Runtime {
  const r = useContext(RuntimeCtx);
  if (!r) throw new Error("useRuntime outside RuntimeProvider");
  return r;
}
