// Experiment C: 2 task-svc replicas, each its own container/CPU, traffic split
// by request-index parity (even -> replica A, odd -> replica B) — same technique
// as k6/phase13-open-channels.js uses for messaging-svc's real 2-replica topology,
// and for the same reason: going straight to each replica (no real LB hop) avoids
// collapsing the account pool's X-Forwarded-For trust model onto one address.
import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

const AUTH = __ENV.AUTH_BASE || "http://127.0.0.1:8001";
const TASK_A = __ENV.TASK_BASE_A || "http://127.0.0.1:18010";
const TASK_B = __ENV.TASK_BASE_B || "http://127.0.0.1:18011";
const ORIGIN = __ENV.ORIGIN || "http://localhost:5173";
const PASSWORD = __ENV.LT_PASSWORD || "LoadTest12345!";

const CONST_RPS = Number(__ENV.CONST_RPS || 0);
const HOLD = __ENV.HOLD || "30s";

const t = {
  inboxA: new Trend("ep_inbox_a", true), inboxB: new Trend("ep_inbox_b", true),
  stickyA: new Trend("ep_sticky_a", true), stickyB: new Trend("ep_sticky_b", true),
};
const errors = new Counter("endpoint_errors");
const reqCountA = new Counter("req_count_a");
const reqCountB = new Counter("req_count_b");

export const options = {
  scenarios: {
    capacity: {
      executor: "constant-arrival-rate",
      rate: CONST_RPS, timeUnit: "1s", duration: HOLD,
      preAllocatedVUs: 200, maxVUs: 1500,
    },
  },
  thresholds: { http_req_failed: ["rate<0.05"] },
};

const USERS = JSON.parse(open(__ENV.LT_USERS));

export function setup() {
  const tokens = [];
  for (let i = 0; i < USERS.length; i++) {
    const res = http.post(`${AUTH}/auth/login`, JSON.stringify({ email: USERS[i], password: PASSWORD }),
      { headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": `198.51.100.${(i % 250) + 1}` } });
    if (res.status === 200) tokens.push(res.json("accessToken"));
  }
  return { tokens };
}

let counter = 0;
export default function (data) {
  const pick = Math.floor(Math.random() * data.tokens.length);
  const params = {
    headers: {
      Authorization: `Bearer ${data.tokens[pick]}`, Origin: ORIGIN,
      "X-Forwarded-For": `198.51.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250) + 1}`,
    },
  };
  const idx = counter++;
  const useA = idx % 2 === 0;
  const base = useA ? TASK_A : TASK_B;
  const r = Math.random();
  const path = r < 0.7 ? "/api/v1/tasks/inbox" : "/api/v1/tasks/sticky";
  const res = http.get(`${base}${path}`, params);
  if (useA) { reqCountA.add(1); (r < 0.7 ? t.inboxA : t.stickyA).add(res.timings.duration); }
  else { reqCountB.add(1); (r < 0.7 ? t.inboxB : t.stickyB).add(res.timings.duration); }
  if (!check(res, { "status 200": (rr) => rr.status === 200 })) errors.add(1);
}
