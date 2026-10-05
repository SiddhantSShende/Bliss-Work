/**
 * Backend service endpoints — mirrors apps/desktop/src/shared/endpoints.ts
 * almost exactly (same production origin, same per-service `/api/<svc>`
 * paths, same dev-against-local-compose defaults), because it solves the
 * identical problem: one definition both the API client and the WS client
 * build from, so a build can never authenticate against one host and open
 * its socket against another.
 *
 * `stickyBase` is deliberately omitted — it's the durable record of which
 * task NOTE belongs on a DESKTOP, a concept this app has no equivalent of.
 * `ApiClient`'s own `stickyBase` field is optional for exactly this reason.
 */
export interface Endpoints {
  authBase: string;
  taskBase: string;
  notificationBase: string;
  messagingBase: string;
  telemetryBase: string;
  wsUrl: string;
}

/** The hosted BlissWork backend — the SAME origin the production web app
 *  and the packaged desktop app both use. */
const PROD_ORIGIN = 'https://communication.rnrtechs.com';

export const PROD_ENDPOINTS: Endpoints = {
  authBase: `${PROD_ORIGIN}/api/auth`,
  taskBase: `${PROD_ORIGIN}/api/tasks`,
  notificationBase: `${PROD_ORIGIN}/api/notifications`,
  messagingBase: `${PROD_ORIGIN}/api/messaging`,
  telemetryBase: `${PROD_ORIGIN}/api/telemetry`,
  wsUrl: 'wss://communication.rnrtechs.com/ws',
};

/**
 * Dev targets the local compose stack (see docker-compose.yml).
 *
 * `localhost` resolves differently per RN run target: the iOS Simulator
 * shares the host Mac's network namespace, so `localhost` reaches a
 * docker-compose stack running on the same machine directly. The Android
 * emulator does NOT — it needs the special alias `10.0.2.2`, which the
 * emulator maps back to the host machine's `localhost`. A physical device
 * (either platform) needs the host machine's real LAN IP instead of either
 * of these. `devHost()` below picks the right default per platform; a real
 * device still needs an explicit override (see `resolveEndpoints`).
 */
import { NativeModules } from 'react-native';

const DEV_HOSTS = { ios: 'localhost', android: '10.0.2.2' } as const;

export function devHost(platformOS: 'ios' | 'android'): string {
  // If EXPO_PUBLIC_API_HOST is defined, use it directly
  if (process.env.EXPO_PUBLIC_API_HOST) {
    return process.env.EXPO_PUBLIC_API_HOST;
  }
  
  // Try to dynamically determine the Metro bundler IP so physical devices work on the LAN.
  // NativeModules.SourceCode.scriptURL looks like "http://192.168.1.5:8081/index.bundle?..."
  try {
    const scriptURL = NativeModules.SourceCode?.scriptURL;
    if (scriptURL) {
      const match = scriptURL.match(/^https?:\/\/([^:]+)/);
      if (match && match[1] && match[1] !== 'localhost' && match[1] !== '10.0.2.2') {
        return match[1];
      }
    }
  } catch (e) {
    // Fallback to defaults
  }
  return DEV_HOSTS[platformOS];
}

export function devEndpoints(platformOS: 'ios' | 'android'): Endpoints {
  const host = devHost(platformOS);
  return {
    authBase: `http://${host}:8001`,
    taskBase: `http://${host}:8002`,
    notificationBase: `http://${host}:8003`,
    messagingBase: `http://${host}:8004`,
    telemetryBase: `http://${host}:8006`,
    wsUrl: `ws://${host}:8090/ws`,
  };
}

/**
 * Resolve the endpoint set.
 *
 * @param isProd  `!__DEV__` at the call site — React Native's own built-in
 *   dev/release flag, no extra config needed to read it.
 * @param platformOS  `Platform.OS` — only consulted in dev, to pick the
 *   right `localhost` alias (see devEndpoints above).
 * @param overrides  per-key overrides, for a physical device pointed at a
 *   LAN IP instead of an emulator/simulator default, or a future
 *   `react-native-config`-sourced value once native build flavors exist.
 *   Undefined/empty values fall through to the default.
 */
export function resolveEndpoints(
  isProd: boolean,
  platformOS: 'ios' | 'android',
  overrides: Partial<Record<keyof Endpoints, string | undefined>> = {},
): Endpoints {
  const base = isProd ? PROD_ENDPOINTS : devEndpoints(platformOS);
  const pick = (k: keyof Endpoints) => overrides[k] || base[k];
  return {
    authBase: pick('authBase'),
    taskBase: pick('taskBase'),
    notificationBase: pick('notificationBase'),
    messagingBase: pick('messagingBase'),
    telemetryBase: pick('telemetryBase'),
    wsUrl: pick('wsUrl'),
  };
}
