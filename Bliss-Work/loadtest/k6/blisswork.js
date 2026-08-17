// BlissWork load profile — capacity measurement.
//
// ── Why an OPEN model (ramping-arrival-rate) and not VUs ─────────────────────
//
// A closed model (N virtual users looping) cannot measure capacity. Each VU
// waits for its response before issuing the next request, so when the system
// slows down the offered load falls with it — the test throttles itself to
// whatever the system happens to manage and reports "no errors" at every size.
// You measure the system's speed, never its ceiling.
//
// `ramping-arrival-rate` holds the ARRIVAL rate regardless of how the system is
// coping, which is how real users behave: nobody waits for your p99 before
// deciding to open the app. Saturation then shows up as it actually does in
// production — latency climbing, then queueing, then errors.
//
// ── The request mix ──────────────────────────────────────────────────────────
//
// Weighted to the profile in QUICK_START_OPTIMIZATION.md rather than spread
// evenly, because an even spread would over-weight the expensive writes and
// under-report capacity. Reads dominate real chat traffic by a wide margin.
//
//   60%  inbox / conversations / notifications   the dominant read
//   20%  channel list + message page             the second read
//   10%  task reads
//    5%  directory
//    4%  message send                            the write that fans out
//    1%  login                                   Argon2; deliberately rare
//
// Login is 1% on purpose. It is by far the most expensive single call (password
// hashing is *designed* to burn CPU), so its share has to reflect sign-ins
// rather than requests — size the auth fleet for peak sign-in separately, which
// is what INFRASTRUCTURE.md means by "size that fleet for peak sign-ins, not
// steady DAU".
import http from "k6/http";
import { check, fail } from "k6";
import { Trend, Counter } from "k6/metrics";

const AUTH = __ENV.AUTH_BASE || "http://127.0.0.1:8001";
const MSG = __ENV.MSG_BASE || "http://127.0.0.1:8004";
const TASK = __ENV.TASK_BASE || "http://127.0.0.1:8002";
const NOTIF = __ENV.NOTIF_BASE || "http://127.0.0.1:8003";
const ORIGIN = __ENV.ORIGIN || "http://localhost:5173";

const EMAIL = __ENV.LT_EMAIL;
const PASSWORD = __ENV.LT_PASSWORD || "LoadTest12345!";
const CHANNEL = __ENV.LT_CHANNEL;

// task-svc is excluded when SKIP_TASK is set. Needed on this box because the
// deployed task-svc image predates app/net.py, so its limiter cannot see
// X-Forwarded-For and buckets the WHOLE fleet into one 600/min key — it
// returns 429 from ~10 rps upward no matter how the load is spread. Leaving it
// in makes every reading above 50 rps a measurement of that one stale
// container rather than of the system.
const SKIP_TASK = !!__ENV.SKIP_TASK;

const START_RPS = Number(__ENV.START_RPS || 25);
const PEAK_RPS = Number(__ENV.PEAK_RPS || 400);
const STAGE = __ENV.STAGE || "30s";

// Per-endpoint latency, so a single slow path is visible instead of being
// averaged into the aggregate.
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

// Two modes, because they answer different questions.
//
//   CONST_RPS  — hold one arrival rate and report p99 for it. Stepping this
//                across several runs is what draws a throughput/latency curve,
//                and the knee in that curve is the capacity number. This is the
//                mode to use for a measurement you intend to quote.
//   (default)  — one continuous ramp. Useful for finding the rough area to
//                step through, and for seeing recovery behaviour, but its
//                aggregate p99 blends every rate it passed through and so is
//                not a capacity figure.
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
      // preAllocatedVUs must be generous: under an open model these are the
      // workers that carry the arrival rate, and starving them would silently
      // convert this back into a closed model — the exact failure this
      // executor was chosen to avoid.
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
  // Thresholds do not abort the run — they classify it. The knee is found by
  // reading per-stage latency, not by the run going red.
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(99)<1000"],
  },
};

// A pool of accounts, because the rate limits are keyed on the VERIFIED USER.
// One account caps the whole test at ~10 rps of 429s and tells you nothing
// about capacity. See loadtest/provision.sh.
const USERS = __ENV.LT_USERS
  ? JSON.parse(open(__ENV.LT_USERS))
  : EMAIL
    ? [EMAIL]
    : [];

export function setup() {
  if (USERS.length === 0) fail("set LT_USERS (see loadtest/provision.sh) or LT_EMAIL");
  const tokens = [];
  for (let i = 0; i < USERS.length; i++) {
    const res = http.post(
      `${AUTH}/auth/login`,
      JSON.stringify({ email: USERS[i], password: PASSWORD }),
      {
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          // Login is capped at 10/60s per caller address; a distinct value per
          // account keeps setup from rate-limiting itself.
          "X-Forwarded-For": `198.51.100.${(i % 250) + 1}`,
        },
      },
    );
    if (res.status === 200) tokens.push(res.json("accessToken"));
  }
  if (tokens.length === 0) fail("no account could log in");

  // A channel PER ACCOUNT. Every provisioned account is the admin of its own
  // org, and channels are org-scoped — so pointing the whole pool at one
  // channel id returns 403 for all but its owner. Those 403s are the store
  // correctly refusing a cross-org read; counting them as load-test failures
  // would be blaming the system for the test's own mistake.
  const channels = [];
  for (let i = 0; i < tokens.length; i++) {
    const params = {
      headers: {
        Authorization: `Bearer ${tokens[i]}`,
        Origin: ORIGIN,
        "Content-Type": "application/json",
        "X-Forwarded-For": `198.51.100.${(i % 250) + 1}`,
      },
    };
    const res = http.post(`${MSG}/api/v1/channels`, JSON.stringify({ name: `lt-${i}` }), params);
    channels.push(res.status === 201 || res.status === 200 ? res.json("id") : null);
    // Seed one message so the message-page read returns a realistic row rather
    // than an empty list, which would not exercise the decrypt path at all.
    if (channels[i]) {
      http.post(
        `${MSG}/api/v1/channels/${channels[i]}/messages`,
        JSON.stringify({ body: "seed", clientMsgId: uuidv4() }),
        params,
      );
    }
  }
  return { tokens, channels };
}

// clientMsgId must be a real UUID — the server rejects anything else with
// `400 body, clientMsgId required`, which reads like a missing field and is
// actually a malformed one. k6 has no built-in uuid, so generate v4 here.
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
    if (__ENV.DEBUG_FAIL) console.log(`FAIL ${res.status} ${url} :: ${String(res.body).slice(0,120)}`);
  }
  return res;
}

export default function (data) {
  // Spread across the account pool so the per-USER budget never binds, and
  // across addresses so the per-IP one never does either. Both are policy
  // limits; leaving either in play would measure the limiter instead of the
  // system, which is the single most common way a load test lies.
  //
  // Selected per ITERATION, not per VU. Under an open model with millisecond
  // responses k6 keeps only a handful of VUs busy, so `__VU % pool` lands on
  // two or three accounts and the per-user budget binds exactly as if there
  // were no pool at all — which is precisely the failure this pool exists to
  // avoid, and it looks like capacity saturation when it happens.
  const pick = Math.floor(Math.random() * data.tokens.length);
  const token = data.tokens[pick];
  const params = {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "X-Forwarded-For": `198.51.${Math.floor(Math.random()*200)}.${Math.floor(Math.random()*250)+1}`,
    },
  };

  // One weighted draw per iteration. The arrival rate is what is being
  // controlled, so each iteration must be ONE user action — batching several
  // requests per iteration would make the configured rate a lie.
  const r = Math.random() * 100;

  if (r < 25) {
    if (SKIP_TASK) get(`${MSG}/api/v1/conversations`, t.conversations, params);
    else get(`${TASK}/api/v1/tasks/inbox`, t.inbox, params);
  } else if (r < 45) {
    get(`${MSG}/api/v1/conversations`, t.conversations, params);
  } else if (r < 60) {
    get(`${NOTIF}/api/v1/notifications`, t.notifications, params);
  } else if (r < 72) {
    get(`${MSG}/api/v1/channels`, t.channels, params);
  } else if (r < 80) {
    const ch = data.channels ? data.channels[pick] : CHANNEL;
    if (ch) {
      get(`${MSG}/api/v1/channels/${ch}/messages?limit=50`, t.messages, params);
    } else {
      get(`${MSG}/api/v1/channels`, t.channels, params);
    }
  } else if (r < 85) {
    get(`${MSG}/api/v1/channels/open?limit=50`, t.browse, params);
  } else if (r < 95) {
    if (SKIP_TASK) get(`${NOTIF}/api/v1/notifications`, t.notifications, params);
    else get(`${TASK}/api/v1/tasks/inbox`, t.tasks, params);
  } else if (r < 99) {
    get(`${AUTH}/auth/directory`, t.directory, params);
  } else if (r < 99.5) {
    // The write that fans out. clientMsgId is the server's idempotency key, so
    // it must be unique per send or the store returns the FIRST message every
    // time and the write is never actually exercised.
    const body = JSON.stringify({
      body: `load ${Date.now()}-${__VU}-${__ITER}`,
      clientMsgId: uuidv4(),
    });
    const ch2 = data.channels ? data.channels[pick] : CHANNEL;
    const res = http.post(`${MSG}/api/v1/channels/${ch2}/messages`, body, params);
    t.send.add(res.timings.duration);
    if (!check(res, { "send ok": (r2) => r2.status === 201 || r2.status === 200 })) errors.add(1);
  } else {
    const res = http.post(
      `${AUTH}/auth/login`,
      JSON.stringify({ email: USERS[pick % USERS.length], password: PASSWORD }),
      { headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-Forwarded-For": params.headers["X-Forwarded-For"] } },
    );
    t.login.add(res.timings.duration);
    if (!check(res, { "login ok": (r2) => r2.status === 200 })) errors.add(1);
  }
}
