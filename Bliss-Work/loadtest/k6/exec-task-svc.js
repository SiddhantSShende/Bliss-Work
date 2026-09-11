// Execution-phase isolation test: task-svc ONLY (/tasks/inbox, /tasks/sticky).
// Modeled directly on blisswork.js's setup()/auth pattern, narrowed to the two
// endpoints under investigation so messaging-svc/auth-svc/notification-svc
// traffic cannot mask or contribute to whatever task-svc alone produces.
import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

const AUTH = __ENV.AUTH_BASE || "http://127.0.0.1:8001";
const TASK = __ENV.TASK_BASE || "http://127.0.0.1:8002";
const ORIGIN = __ENV.ORIGIN || "http://localhost:5173";
const PASSWORD = __ENV.LT_PASSWORD || "LoadTest12345!";

const CONST_RPS = Number(__ENV.CONST_RPS || 0);
const HOLD = __ENV.HOLD || "30s";
const START_RPS = Number(__ENV.START_RPS || 25);
const PEAK_RPS = Number(__ENV.PEAK_RPS || 200);
const STAGE = __ENV.STAGE || "20s";

const t = { inbox: new Trend("ep_inbox", true), sticky: new Trend("ep_sticky", true) };
const errors = new Counter("endpoint_errors");

const constantScenario = {
  executor: "constant-arrival-rate",
  rate: CONST_RPS,
  timeUnit: "1s",
  duration: HOLD,
  preAllocatedVUs: 200,
  maxVUs: 1500,
};

export const options = {
  scenarios: {
    capacity: CONST_RPS > 0 ? constantScenario : {
      executor: "ramping-arrival-rate",
      startRate: START_RPS,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 1500,
      stages: [
        { target: START_RPS, duration: STAGE },
        { target: Math.round(PEAK_RPS * 0.5), duration: STAGE },
        { target: PEAK_RPS, duration: STAGE },
      ],
    },
  },
  thresholds: { http_req_failed: ["rate<0.05"] },
};

const USERS = JSON.parse(open(__ENV.LT_USERS));

export function setup() {
  const tokens = [];
  for (let i = 0; i < USERS.length; i++) {
    const res = http.post(
      `${AUTH}/auth/login`,
      JSON.stringify({ email: USERS[i], password: PASSWORD }),
      { headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": `198.51.100.${(i % 250) + 1}` } },
    );
    if (res.status === 200) tokens.push(res.json("accessToken"));
  }
  return { tokens };
}

export default function (data) {
  const pick = Math.floor(Math.random() * data.tokens.length);
  const params = {
    headers: {
      Authorization: `Bearer ${data.tokens[pick]}`,
      Origin: ORIGIN,
      "X-Forwarded-For": `198.51.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250) + 1}`,
    },
  };
  const r = Math.random();
  const url = r < 0.7 ? `${TASK}/api/v1/tasks/inbox` : `${TASK}/api/v1/tasks/sticky`;
  const trend = r < 0.7 ? t.inbox : t.sticky;
  const res = http.get(url, params);
  trend.add(res.timings.duration);
  if (!check(res, { "status 200": (rr) => rr.status === 200 })) errors.add(1);
}
