/**
 * Does a real call actually connect and carry media — not merely "is the SFU
 * process up" or "did a token get minted".
 *
 *   node scripts/synthetic-call-check.mjs
 *
 * ── Why this exists (Level 4 of this platform's calling observability) ──────
 * Three layers already exist and none of them can see the thing that matters:
 *
 *   1. Healthcheck  — is the LiveKit/coturn process listening.  != media health.
 *   2. SFU metrics  — livekit_room_total, livekit_participant_total, etc.
 *                      (infra/livekit/livekit.yaml's prometheus: block).
 *                      A metrics endpoint answering 200 says nothing about
 *                      whether any of those rooms ever carried real audio.
 *   3. Call metrics — messaging_call_attempt_total / _connected_total / ...
 *                      (services/messaging-svc/internal/metrics/calls.go).
 *                      These are real signal, but they are OBSERVATIONS of
 *                      real user traffic — on a quiet night with zero calls
 *                      they report nothing at all, good or bad.
 *
 * This script is the fourth layer: it manufactures one real call end to end —
 * mint a token, open a real WebRTC connection through the real SFU (and, when
 * LIVEKIT_URL points at the public edge, through the real reverse proxy and
 * WAF too), publish a real (fake-device) audio track, tear it down — on a
 * schedule, whether or not any human is calling anyone. It is the closest
 * thing this stack has to "can a user actually make a call right now", and it
 * is deliberately still not a substitute for the other three: it proves ONE
 * path connects at ONE point in time, not that every user's specific device,
 * network, or peer connection will.
 *
 * ── Safety: this must never touch a real user's call ────────────────────────
 *   - Dedicated room: `synthetic-check-<timestamp>`, unique per run.
 *   - Dedicated identity: `synthetic-monitor` — not a real account, and it can
 *     only ever be present in the dedicated room above.
 *   - The room is deleted server-side when the check finishes (see
 *     deleteRoom below); LiveKit's own `empty_timeout: 120`
 *     (infra/livekit/livekit.yaml) is the documented fallback if that
 *     delete call itself fails for any reason — either way nothing lingers.
 *
 * ── Why the LiveKit token is hand-rolled instead of using an SDK ────────────
 * Same reasoning as services/messaging-svc/internal/livekit/token.go: a
 * LiveKit access token is a dozen JWT claims in a documented shape, HS256-
 * signed. `livekit-server-sdk` is not a dependency of this repo anywhere
 * (confirmed via `grep -r livekit-server-sdk package.json`), and pulling in a
 * server SDK to produce twelve claims would be exactly the kind of
 * unnecessary dependency CODING_PRACTICES.md section 22 warns against when
 * Node's built-in `crypto` already does it in a few lines. mintJoinToken and
 * mintRoomManagementToken below mirror token.go's Mint and rooms.go's
 * roomManagementToken claim-for-claim.
 *
 * ── Why the browser step is NOT skip-and-pass when Playwright is missing ────
 * scripts/smoke-web.mjs (this repo's other synthetic check, general web-app
 * boot) warns and skips its browser step when Playwright is unavailable,
 * because its two cheaper checks (page served, assets resolve) still gate a
 * real class of failure on their own. There is no equivalent cheap check
 * here: minting a token proves only that LIVEKIT_API_SECRET is set and 32+
 * bytes — it says nothing about whether a WebRTC connection can actually be
 * established. Treating a missing Playwright as PASS would make this whole
 * layer a no-op that always reports green, which is worse than not having it.
 * So: no Playwright => FAIL, loudly, with a message that says exactly why —
 * see runBrowserCheck.
 *
 * ── Env ───────────────────────────────────────────────────────────────────
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET   — same names as
 *     .env.prod (see .env.prod.example's "Group calls — LiveKit SFU"
 *     section). The secret's VALUE is never logged — only whether each of
 *     the three was present is printed.
 *   LIVEKIT_API_URL   — optional, mirrors token.go's MinterOptions.APIURL:
 *     an internal address for the SFU's Twirp API when it differs from
 *     LIVEKIT_URL's ws(s):// host. Derived from LIVEKIT_URL when unset,
 *     exactly like httpBaseFromWsUrl below mirrors egress.go's httpBase.
 *   PUSHGATEWAY_URL   — default http://127.0.0.1:9099. NOT 9091: this
 *     repo's own Prometheus already owns host port 9091 in both
 *     docker-compose.yml and docker-compose.prod.yml (`ports:
 *     ["127.0.0.1:9091:9090"]`), so Pushgateway is published on 9099 instead
 *     — see those files' pushgateway service for the container-side port
 *     (still its native 9091; only the host mapping moved).
 *
 * Meant to be run FROM THE HOST (like smoke-web.mjs — see
 * scripts/deploy-prod.sh's smoke_test()), not from inside a container.
 *
 * Exit 0 = PASS, 1 = FAIL. Pushes its result to Pushgateway on either outcome
 * (see pushResult) but a push failure never changes the exit code — the
 * check's own result is what matters, and scripts/smoke-web.mjs establishes
 * the same "don't let a secondary concern flip the primary result" precedent
 * for its own warn-and-continue steps.
 */
import crypto from "node:crypto";

const OVERALL_TIMEOUT_MS = 30_000;
const BROWSER_TIMEOUT_MS = 15_000;
const ROOM = `synthetic-check-${Date.now()}`;
const IDENTITY = "synthetic-monitor";
// Pinned to the exact version packages/app/package.json depends on
// ("livekit-client": "^2.21.0"), loaded from jsdelivr's CDN rather than
// bundled: this is a standalone Node test script with no build step of its
// own, not shipped product code, so a pinned CDN script tag is the pragmatic
// choice here (see the artifact/skill guidance this mirrors for test-only
// pages). jsdelivr serves the `.min.js` variant of any package file it hosts.
const LIVEKIT_CLIENT_VERSION = "2.21.0";

const startedAt = Date.now();
let failed = false;
let failReason = "";

const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failed = true;
  if (!failReason) failReason = msg;
};
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.warn(`  ! ${msg}`);

// ── JWT: hand-rolled, matching LiveKit's documented claim shape ─────────────

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signJWT(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

// mintJoinToken mirrors token.go's Mint: a room-scoped grant that can publish
// and subscribe. TTL is short — this token lives for the duration of one
// check, never longer.
function mintJoinToken({ apiKey, apiSecret, room, identity, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  return signJWT(
    {
      iss: apiKey,
      sub: identity,
      iat: now,
      nbf: now,
      exp: now + ttlSeconds,
      name: identity,
      video: {
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
    },
    apiSecret,
  );
}

// mintRoomManagementToken mirrors rooms.go's roomManagementToken exactly,
// including the same warning that matters: the Twirp RoomService API (what
// deleteRoom below calls) authorizes on the `roomCreate` grant ONLY. A token
// carrying `roomAdmin` instead — the grant that governs what a PARTICIPANT
// may do once connected — is rejected by LiveKit with 401 "permissions
// denied", verified against a live deployment per rooms.go's own comment.
// `roomCreate` is a service-wide grant with no room-scoped variant, which is
// why the mitigation is the same one rooms.go uses: a lifetime barely longer
// than the single request that needs it.
function mintRoomManagementToken({ apiKey, apiSecret, ttlSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  return signJWT(
    {
      iss: apiKey,
      sub: apiKey,
      iat: now,
      nbf: now,
      exp: now + ttlSeconds,
      video: { roomCreate: true },
    },
    apiSecret,
  );
}

// httpBaseFromWsUrl mirrors egress.go's httpBase: turn the public ws(s)://
// signaling URL into the http(s) base the Twirp REST API lives at.
function httpBaseFromWsUrl(wsUrl) {
  if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice("wss://".length);
  if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice("ws://".length);
  return wsUrl;
}

// deleteRoom mirrors rooms.go's DeleteRoom: POST the Twirp RoomService API,
// authorized by the roomCreate-only token above. Idempotent by LiveKit's own
// contract (deleting an already-gone room succeeds), so this is safe to call
// unconditionally during cleanup.
async function deleteRoom({ apiUrl, apiKey, apiSecret, room }) {
  const token = mintRoomManagementToken({ apiKey, apiSecret, ttlSeconds: 60 });
  const url = `${apiUrl.replace(/\/+$/, "")}/twirp/livekit.RoomService/DeleteRoom`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ room }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

// ── The browser step: a real WebRTC connection, headless ────────────────────

function testPageHtml() {
  // Minimal on purpose: one CDN script tag, nothing else loads. `--use-fake-
  // device-for-media-stream` (passed to chromium.launch below) is what gives
  // this page a camera/mic to publish with no real hardware and no
  // permission prompt — Chromium's own standard mechanism for headless
  // WebRTC testing.
  return `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/livekit-client@${LIVEKIT_CLIENT_VERSION}/dist/livekit-client.umd.min.js"></script>
</head><body></body></html>`;
}

async function runBrowserCheck({ livekitUrl, token }) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    // See the header comment: this is a hard failure, not a warn-and-skip.
    throw new Error(
      "playwright not installed — cannot verify actual media connectivity. " +
        "This is treated as FAIL (not skipped) because there is no cheaper " +
        "check here that proves a call connects.",
    );
  }

  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  try {
    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    const page = await context.newPage();
    await page.setContent(testPageHtml());

    const evaluation = page.evaluate(
      async ({ livekitUrl, token }) => {
        try {
          if (!window.LivekitClient) return { connected: false, published: false, error: "livekit-client failed to load from the CDN" };
          const { Room, RoomEvent } = window.LivekitClient;
          const room = new Room();
          const connected = await new Promise((resolve) => {
            room.once(RoomEvent.Connected, () => resolve(true));
            room.connect(livekitUrl, token).catch(() => resolve(false));
          });
          let published = false;
          if (connected) {
            const pub = await room.localParticipant.setMicrophoneEnabled(true).catch(() => undefined);
            published = Boolean(pub);
            await room.disconnect().catch(() => {});
          }
          return { connected, published, error: null };
        } catch (e) {
          return { connected: false, published: false, error: String((e && e.message) || e) };
        }
      },
      { livekitUrl, token },
    );

    return await Promise.race([
      evaluation,
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ connected: false, published: false, error: `no result within ${BROWSER_TIMEOUT_MS}ms` }),
          BROWSER_TIMEOUT_MS,
        ),
      ),
    ]);
  } finally {
    // Terminates the browser process (and with it, whatever page-side
    // connect/publish call may still be in flight past the timeout above) —
    // nothing is left running once this function returns.
    await browser.close().catch(() => {});
  }
}

// ── Pushgateway: report the result whether this run passed or failed ────────

async function pushResult({ success, durationSeconds }) {
  const base = (process.env.PUSHGATEWAY_URL || "http://127.0.0.1:9099").replace(/\/+$/, "");
  const body =
    `synthetic_call_success ${success ? 1 : 0}\n` +
    `synthetic_call_duration_seconds ${durationSeconds.toFixed(3)}\n` +
    `synthetic_call_last_run_timestamp_seconds ${Math.floor(Date.now() / 1000)}\n`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`${base}/metrics/job/synthetic_call`, {
      method: "POST",
      body,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ok(`pushed result to pushgateway (${base})`);
  } catch (e) {
    // Deliberately does not affect the exit code — see the header comment.
    warn(`could not push to pushgateway at ${base}: ${e.message}`);
  } finally {
    clearTimeout(t);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const livekitUrl = process.env.LIVEKIT_URL || "";
  const apiKey = process.env.LIVEKIT_API_KEY || "";
  const apiSecret = process.env.LIVEKIT_API_SECRET || "";

  // Booleans only — never the secret value itself.
  console.log(`  LIVEKIT_URL present: ${Boolean(livekitUrl)}`);
  console.log(`  LIVEKIT_API_KEY present: ${Boolean(apiKey)}`);
  console.log(`  LIVEKIT_API_SECRET present: ${Boolean(apiSecret)}`);

  if (!livekitUrl || !apiKey || !apiSecret) {
    fail("LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must all be set — group calling is not configured on this deployment");
    return;
  }

  const joinToken = mintJoinToken({ apiKey, apiSecret, room: ROOM, identity: IDENTITY, ttlSeconds: 120 });
  ok(`minted a join token for room ${ROOM}`);

  let result = null;
  try {
    result = await runBrowserCheck({ livekitUrl, token: joinToken });
  } catch (e) {
    fail(e.message);
  }

  if (result) {
    if (result.error) fail(`browser step reported an error: ${result.error}`);
    if (!result.connected) fail("RoomEvent.Connected never fired within the timeout — no real SFU connection was established");
    else ok("LiveKit Room reported Connected");
    if (!result.published) fail("local audio track was not published — a connection alone is not a working call");
    else ok("local (fake-device) audio track published");
  }

  // Best-effort cleanup — never changes the check's own pass/fail result.
  // See the header comment for why an explicit delete is attempted first,
  // with empty_timeout as the documented fallback.
  try {
    const apiUrl = process.env.LIVEKIT_API_URL || httpBaseFromWsUrl(livekitUrl);
    await deleteRoom({ apiUrl, apiKey, apiSecret, room: ROOM });
    ok(`deleted room ${ROOM} server-side`);
  } catch (e) {
    warn(
      `could not explicitly delete room ${ROOM} (${e.message}) — relying on LiveKit's ` +
        `empty_timeout (120s, infra/livekit/livekit.yaml) to reap it instead`,
    );
  }
}

const overallTimeout = new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`exceeded the overall ${OVERALL_TIMEOUT_MS}ms budget`)), OVERALL_TIMEOUT_MS),
);

try {
  await Promise.race([main(), overallTimeout]);
} catch (e) {
  fail(e.message);
}

const durationSeconds = (Date.now() - startedAt) / 1000;
await pushResult({ success: !failed, durationSeconds });

if (failed) {
  console.error(`\nsynthetic call check FAILED${failReason ? `: ${failReason}` : ""} (${durationSeconds.toFixed(1)}s)`);
  process.exit(1);
}
console.log(`\nsynthetic call check passed (${durationSeconds.toFixed(1)}s)`);
process.exit(0);
