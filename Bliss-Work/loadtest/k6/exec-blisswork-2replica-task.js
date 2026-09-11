// Remediation experiment: identical to blisswork.js (Scenario A, the realistic
// weighted mix), with ONE change — task-svc's two call sites alternate between
// TASK_BASE_A/TASK_BASE_B (two independent 1-CPU replicas) instead of hitting a
// single TASK_BASE. Everything else (mix weights, account pool, setup, other
// endpoints) is untouched from blisswork.js. This measures whether fixing
// task-svc's own ceiling (Experiment C: 2 replicas beat 2/4 workers under a
// shared 1-CPU limit) raises the OVERALL application's measured capacity, not
// just the isolated task-svc endpoint's.
import http from "k6/http";
import { check, fail } from "k6";
import { Trend, Counter } from "k6/metrics";

const AUTH = __ENV.AUTH_BASE || "http://127.0.0.1:8001";
const MSG = __ENV.MSG_BASE || "http://127.0.0.1:8004";
const TASK_A = __ENV.TASK_BASE_A || "http://127.0.0.1:18010";
const TASK_B = __ENV.TASK_BASE_B || "http://127.0.0.1:18011";
const NOTIF = __ENV.NOTIF_BASE || "http://127.0.0.1:8003";
const ORIGIN = __ENV.ORIGIN || "http://localhost:5173";

const EMAIL = __ENV.LT_EMAIL;
const PASSWORD = __ENV.LT_PASSWORD || "LoadTest12345!";
const CHANNEL = __ENV.LT_CHANNEL;

const START_RPS = Number(__ENV.START_RPS || 25);
const PEAK_RPS = Number(__ENV.PEAK_RPS || 400);
const STAGE = __ENV.STAGE || "30s";

const t = {
  inbox: new Trend("ep_inbox", true),
  conversations: new Trend("ep_conversations", true),
  notifications: new Trend("ep_notifications", true),
  channels: new Trend("ep_channels", true),
  messages: new Trend("ep_messages", true),
  browse: new Trend("ep_browse", true),
  tasks: new Trend("ep_tasks", true),
  directory: new Trend("ep_directory", true),
  send: new Trend("ep_send", true),
  login: new Trend("ep_login", true),
};
const errors = new Counter("endpoint_errors");
const taskReqA = new Counter("task_req_a");
const taskReqB = new Counter("task_req_b");

const CONST_RPS = Number(__ENV.CONST_RPS || 0);
const HOLD = __ENV.HOLD || "30s";

const constantScenario = {
  executor: "constant-arrival-rate",
  rate: CONST_RPS,
  timeUnit: "1s",
  duration: HOLD,
  preAllocatedVUs: 200,
  maxVUs: 2000,
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
        { target: Math.round(PEAK_RPS * 0.25), duration: STAGE },
        { target: Math.round(PEAK_RPS * 0.5), duration: STAGE },
        { target: Math.round(PEAK_RPS * 0.75), duration: STAGE },
        { target: PEAK_RPS, duration: STAGE },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(99)<1000"],
  },
};

const USERS = __ENV.LT_USERS ? JSON.parse(open(__ENV.LT_USERS)) : EMAIL ? [EMAIL] : [];

export function setup() {
  if (USERS.length === 0) fail("set LT_USERS (see loadtest/provision.sh) or LT_EMAIL");
  const tokens = [];
  for (let i = 0; i < USERS.length; i++) {
    const res = http.post(`${AUTH}/auth/login`, JSON.stringify({ email: USERS[i], password: PASSWORD }),
      { headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": `198.51.100.${(i % 250) + 1}` } });
    if (res.status === 200) tokens.push(res.json("accessToken"));
  }
  if (tokens.length === 0) fail("no account could log in");

  const channels = [];
  for (let i = 0; i < tokens.length; i++) {
    const params = {
      headers: { Authorization: `Bearer ${tokens[i]}`, Origin: ORIGIN, "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${(i % 250) + 1}` },
    };
    const res = http.post(`${MSG}/api/v1/channels`, JSON.stringify({ name: `lt-${i}` }), params);
    channels.push(res.status === 201 || res.status === 200 ? res.json("id") : null);
    if (channels[i]) {
      http.post(`${MSG}/api/v1/channels/${channels[i]}/messages`, JSON.stringify({ body: "seed", clientMsgId: uuidv4() }), params);
    }
  }
  return { tokens, channels };
}

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function get(url, trend, params) {
  const res = http.get(url, params);
  trend.add(res.timings.duration);
  if (!check(res, { "status 200": (r) => r.status === 200 })) {
    errors.add(1);
  }
  return res;
}

let taskCounter = 0;
function taskBase() {
  taskCounter++;
  const useA = taskCounter % 2 === 0;
  if (useA) taskReqA.add(1); else taskReqB.add(1);
  return useA ? TASK_A : TASK_B;
}

export default function (data) {
  const pick = Math.floor(Math.random() * data.tokens.length);
  const token = data.tokens[pick];
  const params = {
    headers: {
      Authorization: `Bearer ${token}`, Origin: ORIGIN, "Content-Type": "application/json",
      "X-Forwarded-For": `198.51.${Math.floor(Math.random()*200)}.${Math.floor(Math.random()*250)+1}`,
    },
  };

  const r = Math.random() * 100;

  if (r < 25) {
    get(`${taskBase()}/api/v1/tasks/inbox`, t.inbox, params);
  } else if (r < 45) {
    get(`${MSG}/api/v1/conversations`, t.conversations, params);
  } else if (r < 60) {
    get(`${NOTIF}/api/v1/notifications`, t.notifications, params);
  } else if (r < 72) {
    get(`${MSG}/api/v1/channels`, t.channels, params);
  } else if (r < 80) {
    const ch = data.channels ? data.channels[pick] : CHANNEL;
    if (ch) get(`${MSG}/api/v1/channels/${ch}/messages?limit=50`, t.messages, params);
    else get(`${MSG}/api/v1/channels`, t.channels, params);
  } else if (r < 85) {
    get(`${MSG}/api/v1/channels/open?limit=50`, t.browse, params);
  } else if (r < 95) {
    get(`${taskBase()}/api/v1/tasks/inbox`, t.tasks, params);
  } else if (r < 99) {
    get(`${AUTH}/auth/directory`, t.directory, params);
  } else if (r < 99.5) {
    const body = JSON.stringify({ body: `load ${Date.now()}-${__VU}-${__ITER}`, clientMsgId: uuidv4() });
    const ch2 = data.channels ? data.channels[pick] : CHANNEL;
    const res = http.post(`${MSG}/api/v1/channels/${ch2}/messages`, body, params);
    t.send.add(res.timings.duration);
    if (!check(res, { "send ok": (r2) => r2.status === 201 || r2.status === 200 })) errors.add(1);
  } else {
    const res = http.post(`${AUTH}/auth/login`, JSON.stringify({ email: USERS[pick % USERS.length], password: PASSWORD }),
      { headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": params.headers["X-Forwarded-For"] } });
    t.login.add(res.timings.duration);
    if (!check(res, { "login ok": (r2) => r2.status === 200 })) errors.add(1);
  }
}
