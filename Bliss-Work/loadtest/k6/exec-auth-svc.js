// Phase 6: auth-svc isolation — login (Argon2) and directory read, separately.
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const AUTH = __ENV.AUTH_BASE || "http://127.0.0.1:8001";
const ORIGIN = __ENV.ORIGIN || "http://localhost:5173";
const PASSWORD = __ENV.LT_PASSWORD || "LoadTest12345!";
const MODE = __ENV.MODE || "login"; // "login" or "directory"
const CONST_RPS = Number(__ENV.CONST_RPS || 0);
const HOLD = __ENV.HOLD || "30s";

const t = { op: new Trend("ep_op", true) };
const USERS = JSON.parse(open(__ENV.LT_USERS));

export const options = {
  scenarios: {
    capacity: {
      executor: "constant-arrival-rate", rate: CONST_RPS, timeUnit: "1s", duration: HOLD,
      preAllocatedVUs: 200, maxVUs: 1500,
    },
  },
  thresholds: { http_req_failed: ["rate<0.05"] },
};

export function setup() {
  const tokens = [];
  for (let i = 0; i < USERS.length; i++) {
    const res = http.post(`${AUTH}/auth/login`, JSON.stringify({ email: USERS[i], password: PASSWORD }),
      { headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": `198.51.100.${(i % 250) + 1}` } });
    if (res.status === 200) tokens.push(res.json("accessToken"));
  }
  return { tokens };
}

export default function (data) {
  if (MODE === "login") {
    const pick = Math.floor(Math.random() * USERS.length);
    const res = http.post(`${AUTH}/auth/login`, JSON.stringify({ email: USERS[pick], password: PASSWORD }),
      { headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": `198.51.${Math.floor(Math.random()*200)}.${Math.floor(Math.random()*250)+1}` } });
    t.op.add(res.timings.duration);
    check(res, { "login ok": (r) => r.status === 200 });
  } else {
    const pick = Math.floor(Math.random() * data.tokens.length);
    const res = http.get(`${AUTH}/auth/directory`, {
      headers: { Authorization: `Bearer ${data.tokens[pick]}`, Origin: ORIGIN,
        "X-Forwarded-For": `198.51.${Math.floor(Math.random()*200)}.${Math.floor(Math.random()*250)+1}` },
    });
    t.op.add(res.timings.duration);
    check(res, { "directory ok": (r) => r.status === 200 });
  }
}
