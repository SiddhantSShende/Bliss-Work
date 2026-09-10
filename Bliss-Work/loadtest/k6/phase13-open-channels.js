// Phase 13 — GET /api/v1/channels/open against the ACTUAL 2-replica topology,
// split client-side across both replica URLs rather than through a real
// reverse proxy.
//
// Why not a real LB in front: messaging-svc's PerIP limiter deliberately
// trusts only the LAST N (TRUSTED_PROXY_HOPS, default 1 — the deployed
// Caddy edge) entries of X-Forwarded-For, discarding anything a client
// claims beyond that (see internal/middleware/ratelimit.go's own comment on
// GHSA-3fxj-6jh8-hvhx — an intentional anti-bypass design, not a bug). Once
// this test put a real nginx hop in front, nginx's own appended peer
// (always the same k6 container) became the ONLY address the limiter would
// trust, collapsing every one of this pool's 200 accounts onto one IP
// bucket and 429ing ~25% of requests inside the first few seconds — even
// with fresh tokens. Going STRAIGHT to each replica (zero real proxy hops)
// restores the same trust model Phase 11/12 relied on: the single
// client-supplied X-Forwarded-For entry IS the only entry, so it is what
// the limiter reads — exactly the load-test convention documented in
// loadtest/README.md, not a bypass of anything.
//
// Splitting is done by request index parity (even -> replica A, odd ->
// replica B) rather than k6 VU sharding, so the split is exact regardless of
// how k6 schedules VUs under an open (arrival-rate) model.
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const MSG_A = __ENV.MSG_BASE_A || "http://127.0.0.1:8004";
const MSG_B = __ENV.MSG_BASE_B || "http://127.0.0.1:8004";
const ORIGIN = __ENV.ORIGIN || "http://localhost:5173";

const START_RPS = Number(__ENV.START_RPS || 10);
const PEAK_RPS = Number(__ENV.PEAK_RPS || 50);
const STAGE = __ENV.STAGE || "20s";
const CONST_RPS = Number(__ENV.CONST_RPS || 0);
const PAGE_LIMIT = Number(__ENV.PAGE_LIMIT || 50);

const t = {
  openChannelsA: new Trend("ep_channels_open_a", true),
  openChannelsB: new Trend("ep_channels_open_b", true),
};

const constantScenario = {
  executor: "constant-arrival-rate",
  rate: CONST_RPS,
  timeUnit: "1s",
  duration: __ENV.DURATION || "30s",
  preAllocatedVUs: 300,
  maxVUs: 1000,
};

export const options = {
  scenarios: {
    capacity: CONST_RPS > 0 ? constantScenario : {
      executor: "ramping-arrival-rate",
      startRate: START_RPS,
      timeUnit: "1s",
      preAllocatedVUs: 300,
      maxVUs: 1000,
      stages: [
        { target: START_RPS, duration: STAGE },
        { target: PEAK_RPS, duration: STAGE },
        { target: PEAK_RPS, duration: STAGE },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

const TOKENS = JSON.parse(open(__ENV.LT_TOKENS || "../tokens_p13.json"));

// A wide, monotonically-advancing synthetic address per request rather than
// cycling through a small fixed set — messaging-svc's PerIPMiddleware caps
// each observed address at 300/min (see ratelimit.go), and this session's
// earlier runs all reused the SAME 250 addresses (198.51.100.1-250) across
// many back-to-back bursts, silently exhausting THAT budget regardless of
// how large the account pool was. 10.a.b.c cycling through three octets
// gives ~16M distinct addresses before any repeat.
function syntheticIP(i) {
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
}

// __VU/__ITER, not a module-level counter: k6 instantiates the script once
// PER VU under this executor, so a plain `let counter = 0` at module scope
// is actually one independent counter PER VU, not one shared counter for
// the whole run. At the low VU counts the 50-150 RPS sanity runs used that
// was invisible; at 300+ RPS (hundreds of concurrent VUs), it meant many
// VUs computed the SAME i simultaneously — the same token AND the same
// spoofed IP colliding across dozens of concurrent requests, while most of
// the pool sat unused. __VU (1-indexed, unique per VU) and __ITER
// (0-indexed, per-VU iteration count) together are unique per request
// across the WHOLE run, which a per-VU-scoped counter can never be.
function requestIndex() {
  return __VU * 100000 + __ITER;
}

export default function () {
  const i = requestIndex();
  const params = {
    headers: {
      Authorization: `Bearer ${TOKENS[i % TOKENS.length]}`,
      Origin: ORIGIN,
      "X-Forwarded-For": syntheticIP(i),
    },
  };
  const onA = i % 2 === 0;
  const base = onA ? MSG_A : MSG_B;
  const res = http.get(`${base}/api/v1/channels/open?limit=${PAGE_LIMIT}`, params);
  (onA ? t.openChannelsA : t.openChannelsB).add(res.timings.duration);
  check(res, { "status is 200": (r) => r.status === 200 });
}
