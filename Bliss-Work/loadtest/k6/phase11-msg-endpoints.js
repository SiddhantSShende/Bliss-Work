// Phase 11 — focused load test for messaging-svc's ep_channels/ep_conversations
// (GET /api/v1/channels, GET /api/v1/conversations).
//
// Deliberately narrower than loadtest/k6/blisswork.js's platform-wide mix: this
// isolates JUST the two endpoints under investigation so neither hides the
// other's cost, and so the mix ratio is exactly controlled rather than derived
// from the whole-platform profile. Reuses blisswork.js's open-model reasoning
// (ramping-arrival-rate — a closed VU loop self-throttles and never finds the
// ceiling) and its account-pool-for-rate-limits reasoning verbatim.
//
// Tokens are loaded from an already-minted tokens.json (loadtest/mint-tokens.sh)
// rather than logging in inside setup() — a fresh login per account would spend
// this run's whole ramp on Argon2, which is not what is being measured here.
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const MSG = __ENV.MSG_BASE || "http://127.0.0.1:8004";
const ORIGIN = __ENV.ORIGIN || "http://localhost:5173";

const START_RPS = Number(__ENV.START_RPS || 10);
const PEAK_RPS = Number(__ENV.PEAK_RPS || 50);
const STAGE = __ENV.STAGE || "20s";
const CONST_RPS = Number(__ENV.CONST_RPS || 0);

// MIX selects which endpoint(s): "channels", "conversations", or "both"
// (default) — see Phase 11 brief section 7, "test each endpoint independently".
const MIX = __ENV.MIX || "both";

const t = {
  channels: new Trend("ep_channels", true),
  conversations: new Trend("ep_conversations", true),
};

const constantScenario = {
  executor: "constant-arrival-rate",
  rate: CONST_RPS,
  timeUnit: "1s",
  duration: __ENV.DURATION || "30s",
  preAllocatedVUs: 200,
  maxVUs: 800,
};

export const options = {
  scenarios: {
    capacity: CONST_RPS > 0 ? constantScenario : {
      executor: "ramping-arrival-rate",
      startRate: START_RPS,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 800,
      stages: [
        { target: START_RPS, duration: STAGE },
        { target: PEAK_RPS, duration: STAGE },
        { target: PEAK_RPS, duration: STAGE }, // hold at peak so p95/p99 reflect steady state, not the ramp
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

const TOKENS = JSON.parse(open(__ENV.LT_TOKENS || "../tokens.json"));

function authParams(i) {
  return {
    headers: {
      Authorization: `Bearer ${TOKENS[i % TOKENS.length]}`,
      Origin: ORIGIN,
      "X-Forwarded-For": `198.51.100.${(i % 250) + 1}`,
    },
  };
}

let counter = 0;

export default function () {
  const i = counter++;
  const params = authParams(i);
  const pick = MIX === "channels" ? "channels" : MIX === "conversations" ? "conversations" : (i % 2 === 0 ? "channels" : "conversations");

  const url = pick === "channels" ? `${MSG}/api/v1/channels` : `${MSG}/api/v1/conversations`;
  const res = http.get(url, params);
  t[pick].add(res.timings.duration);
  check(res, { "status is 200": (r) => r.status === 200 });
}
