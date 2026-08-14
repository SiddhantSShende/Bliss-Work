/**
 * Chromium's NETWORK location provider, and the key it needs.
 *
 * `navigator.geolocation` has three possible sources, tried in this order:
 *
 *   1. An OS locator — CoreLocation on macOS, the Location API on Windows 10+.
 *   2. Chromium's network locator, which POSTs the visible WiFi access points
 *      to `https://www.googleapis.com/geolocation/v1/geolocate`.
 *   3. Nothing.
 *
 * Electron ships without an API key, so (2) is dead in every build of every
 * Electron app by default. On Linux there is no (1) either, which is why
 * `getCurrentPosition` fails outright there no matter how the permission
 * handler answers — the failure is NOT a permission problem and no amount of
 * granting fixes it.
 *
 * `useChatMedia` already degrades to the server's IP lookup (`/maps/whereami`)
 * when this happens, so location sharing works with or without a key. The
 * difference is precision: IP geolocation is city-level (tens of kilometres),
 * WiFi trilateration is typically 20-100 metres. For "here's where I am" in a
 * chat, that gap is the whole point of the feature.
 *
 * The key must be in the environment BEFORE Chromium starts, which is why this
 * runs at module scope in main/index.ts rather than inside `whenReady`. By the
 * time the app is ready the network context has been created and the value is
 * simply never read again — a silent no-op with no error anywhere.
 *
 * SECURITY: a key compiled in here ships inside app.asar and is extractable by
 * anyone who unpacks the app. That is inherent — Chromium offers no mechanism
 * that keeps it off the client. Mitigate it entirely on the Google Cloud side:
 * restrict the key to the Geolocation API alone, set a hard daily quota, and
 * put a billing alert on it. The API is billed per request.
 */

/** Injected by electron.vite.config.ts. Empty string when the build had no key. */
declare const __TB_GOOGLE_API_KEY__: string;

/**
 * Publish the geolocation API key to Chromium, if this build has one.
 *
 * Returns whether a key was installed, so `geo:supported` can tell the renderer
 * the truth rather than making it infer capability from a ten-second timeout.
 */
export function installLocationProviderKey(): boolean {
  // Runtime env wins over the baked-in constant so an operator can repoint a
  // build without rebuilding it — the same precedence src/shared/endpoints.ts
  // uses for the service URLs.
  const fromEnv = process.env.TB_GOOGLE_API_KEY?.trim();
  const baked = typeof __TB_GOOGLE_API_KEY__ === "string" ? __TB_GOOGLE_API_KEY__.trim() : "";
  const key = fromEnv || baked;

  // Deliberately leave GOOGLE_API_KEY UNSET rather than setting it to "".
  // Chromium treats an empty key as a real one and issues geolocate requests
  // that come back 400 INVALID_ARGUMENT, which surfaces to the user as
  // POSITION_UNAVAILABLE after the full timeout. Absent is faster and honest.
  if (!key) return false;

  process.env.GOOGLE_API_KEY = key;
  // Chromium reads these two alongside the key and refuses the request without
  // them. They are not secrets; Electron simply has no defaults to inherit.
  process.env.GOOGLE_DEFAULT_CLIENT_ID ??= "";
  process.env.GOOGLE_DEFAULT_CLIENT_SECRET ??= "";
  return true;
}

/**
 * Whether this build can produce a precise fix.
 *
 * False does NOT mean location sharing is broken — the IP fallback still
 * answers. It means the answer will be coarse, which is worth saying out loud
 * in the UI instead of letting the user wonder why the pin is a kilometre off.
 */
export function hasPreciseLocationProvider(): boolean {
  return !!process.env.GOOGLE_API_KEY;
}
