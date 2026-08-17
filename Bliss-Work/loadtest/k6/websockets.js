// WebSocket capacity: how many concurrent sockets the gateway holds, and what
// each one costs.
//
// ── Why the async API and not k6/ws ──────────────────────────────────────────
// The legacy `k6/ws` blocks one VU per socket, so 10,000 sockets means 10,000
// VUs at a few MB each — tens of GB of load generator to measure a gateway that
// INFRASTRUCTURE.md says costs ~2 KB per connection. The generator would fall
// over long before the target, and the number you'd get would be the
// generator's. `k6/experimental/websockets` is event-driven, so one VU holds
// hundreds of sockets and the box under test is the thing that runs out first.
//
// ── What is actually being measured ─────────────────────────────────────────
// Not throughput. The question here is what a HELD connection costs, because
// that is the constraint Stage 11 identified: the gateway's memory per socket
// (measured at 2,079 bytes after sendChanCap was cut) and, more importantly,
// Redis — presence entries plus the replay outbox, which is sized in weekly
// actives rather than in concurrent users.
//
// So the run holds sockets open and idle, and the interesting numbers are read
// from OUTSIDE k6: `ws_connections` on the gateway, its RSS, and Redis
// `used_memory`. See ws-step.sh.
import { WebSocket } from "k6/experimental/websockets";
import { setTimeout } from "k6/timers";
import { Counter, Trend } from "k6/metrics";

const WS = __ENV.WS_URL || "ws://127.0.0.1:8090/ws";
const TOKENS = JSON.parse(open(__ENV.LT_TOKENS || "/tokens.json"));

const SOCKETS_PER_VU = Number(__ENV.SOCKETS_PER_VU || 100);
const HOLD_SEC = Number(__ENV.HOLD_SEC || 30);
// Stagger opens inside a VU. Slamming every socket open in one tick measures
// the accept backlog rather than the steady state, and makes a cold run look
// like a capacity failure.
const OPEN_STAGGER_MS = Number(__ENV.OPEN_STAGGER_MS || 5);

const opened = new Counter("ws_opened");
const ready = new Counter("ws_ready");
const failed = new Counter("ws_failed");
const closedEarly = new Counter("ws_closed_early");
const timeToReady = new Trend("ws_time_to_ready", true);

export const options = {
  scenarios: {
    hold: {
      executor: "per-vu-iterations",
      vus: Number(__ENV.VUS || 20),
      iterations: 1,
      maxDuration: `${Number(__ENV.HOLD_SEC || 30) + 120}s`,
    },
  },
  // A held socket has no request rate; the built-in http thresholds would be
  // meaningless here.
  thresholds: {},
};

export default function () {
  const sockets = [];
  let done = false;

  for (let i = 0; i < SOCKETS_PER_VU; i++) {
    setTimeout(() => {
      if (done) return;
      // Spread across the pool. Each account may hold WS_MAX_CONNS_PER_USER
      // (20) sockets, so the pool size sets the ceiling: 500 accounts is
      // 10,000 sockets and the 10,001st is refused with reason="per_user"
      // rather than for any capacity reason.
      const token = TOKENS[Math.floor(Math.random() * TOKENS.length)];
      const started = Date.now();
      let sock;
      try {
        sock = new WebSocket(`${WS}?token=${token}`);
      } catch (e) {
        failed.add(1);
        return;
      }
      sockets.push(sock);

      sock.onopen = () => {
        opened.add(1);
        // The server waits for `hello` before it sends ready + the presence
        // snapshot + the replay buffer. Without it the socket is connected but
        // has done none of the work a real client triggers on connect.
        sock.send(JSON.stringify({ type: "hello" }));
      };

      sock.onmessage = (msg) => {
        let t;
        try {
          t = JSON.parse(msg.data).type;
        } catch (e) {
          return;
        }
        if (t === "replay.done") {
          ready.add(1);
          timeToReady.add(Date.now() - started);
        }
      };

      sock.onerror = () => failed.add(1);
      sock.onclose = () => {
        if (!done) closedEarly.add(1);
      };
    }, i * OPEN_STAGGER_MS);
  }

  // Hold, then close everything. The close is what makes the next step start
  // from a clean gateway instead of inheriting the previous step's sockets.
  setTimeout(
    () => {
      done = true;
      for (const s of sockets) {
        try {
          s.close();
        } catch (e) {
          /* already gone */
        }
      }
    },
    SOCKETS_PER_VU * OPEN_STAGGER_MS + HOLD_SEC * 1000,
  );
}
