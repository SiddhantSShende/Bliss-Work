// Phase 12 — focused load test for messaging-svc's GET /api/v1/channels/open
// (ListOpenChannels).
//
// Same open-model/account-pool reasoning as loadtest/k6/phase11-msg-
// endpoints.js — see that file's header. Reuses an already-minted
// tokens.json rather than logging in inside setup(), for the same reason.
//
// Paged (limit/offset, default 50, max 200 — see clampChannelPage in
// internal/store/receipts.go): PAGE_LIMIT lets a run choose where in that
// range to sit. Default 50 matches what the real client sends.
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const MSG = __ENV.MSG_BASE || "http://127.0.0.1:8004";
const ORIGIN = __ENV.ORIGIN || "http://localhost:5173";

const START_RPS = Number(__ENV.START_RPS || 10);
const PEAK_RPS = Number(__ENV.PEAK_RPS || 50);
const STAGE = __ENV.STAGE || "20s";
const CONST_RPS = Number(__ENV.CONST_RPS || 0);
const PAGE_LIMIT = Number(__ENV.PAGE_LIMIT || 50);

const t = { openChannels: new Trend("ep_channels_open", true) };

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
        { target: PEAK_RPS, duration: STAGE },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

const TOKENS = JSON.parse(open(__ENV.LT_TOKENS || "../tokens.json"));

let counter = 0;

export default function () {
  const i = counter++;
  const params = {
    headers: {
      Authorization: `Bearer ${TOKENS[i % TOKENS.length]}`,
      Origin: ORIGIN,
      "X-Forwarded-For": `198.51.100.${(i % 250) + 1}`,
    },
  };
  const res = http.get(`${MSG}/api/v1/channels/open?limit=${PAGE_LIMIT}`, params);
  t.openChannels.add(res.timings.duration);
  check(res, { "status is 200": (r) => r.status === 200 });
}
