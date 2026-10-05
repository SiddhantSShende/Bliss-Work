import { describe, expect, it } from "vitest";
import {
  initialState,
  sameApp,
  step,
  type ActivityEvent,
  type AppIdentity,
  type TrackerInput,
  type TrackerOptions,
  type TrackerState,
} from "./activity-spans";

const CHROME: AppIdentity = { name: "chrome.exe", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" };
const CODE: AppIdentity = { name: "Code.exe", path: "C:\\Users\\a\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" };

/** Epoch ms for 10:00:00 on a fixed day, plus the given clock offset. */
const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
const t = (h: number, m: number, s = 0) => BASE + ((h * 60 + m) * 60 + s) * 1000;
const MIN = 60_000;

const sample = (at: number, app: AppIdentity | null, idleSeconds = 0): TrackerInput => ({ type: "sample", at, app, idleSeconds });
const signal = (type: "lock" | "unlock" | "suspend" | "resume" | "quit", at: number): TrackerInput => ({ type, at });

/** Replay inputs through the machine, collecting every event and the final state. */
function run(inputs: TrackerInput[], options?: TrackerOptions) {
  let state: TrackerState = initialState;
  const events: ActivityEvent[] = [];
  for (const input of inputs) {
    const next = step(state, input, options);
    state = next.state;
    events.push(...next.events);
  }
  return { state, events };
}

const app = (a: AppIdentity, startedAt: number, endedAt: number): ActivityEvent => ({
  kind: "app", name: a.name, path: a.path, startedAt, endedAt, durationMs: endedAt - startedAt,
});
const idle = (startedAt: number, endedAt: number): ActivityEvent => ({
  kind: "idle", startedAt, endedAt, durationMs: endedAt - startedAt,
});

describe("A. switching application", () => {
  it("Chrome 10:00 → VS Code 10:30 closes Chrome exactly at the switch and opens VS Code", () => {
    const { events, state } = run([sample(t(10, 0), CHROME), sample(t(10, 30), CODE)]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 30))]);
    expect(events[0]).toMatchObject({ durationMs: 30 * MIN });
    expect(state.app).toMatchObject({ name: "Code.exe", since: t(10, 30) });
  });
});

describe("B. repeated identical snapshots", () => {
  it("emit nothing and keep the span's original start", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      sample(t(10, 0, 5), CHROME),
      sample(t(10, 0, 10), CHROME),
      sample(t(10, 1), CHROME),
    ]);
    expect(events).toEqual([]);
    expect(state.app?.since).toBe(t(10, 0));
  });

  it("treats a path that differs only by case as the same application", () => {
    expect(sameApp(CHROME, { name: "CHROME.EXE", path: CHROME.path.toUpperCase() })).toBe(true);
    expect(sameApp(CHROME, CODE)).toBe(false);
  });

  it("distinguishes two executables that share a name but not a path", () => {
    const other = { name: "chrome.exe", path: "D:\\portable\\chrome.exe" };
    const { events } = run([sample(t(10, 0), CHROME), sample(t(10, 5), other)]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5))]);
  });
});

describe("C. idle begins and ends while an app stays in front", () => {
  // Threshold is 300s. A sample at 10:25 reporting 300s idle means the last
  // input was at 10:20, so that is when the app span ends and idle begins.
  const inputs = [
    sample(t(10, 0), CHROME),
    sample(t(10, 25), CHROME, 300),
    sample(t(10, 40, 5), CHROME, 5), // input resumed at 10:40:00
  ];

  it("closes Chrome at the idle start, closes idle at the return, and counts none of it as app time", () => {
    const { events } = run(inputs);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 20)), idle(t(10, 20), t(10, 40))]);
  });

  it("resumes the foreground app from the active timestamp, not from the idle start", () => {
    const { state } = run(inputs);
    expect(state.idleSince).toBeNull();
    expect(state.app).toMatchObject({ name: "chrome.exe", since: t(10, 40) });
  });

  it("resumes into whichever app is in front on return, even if it changed during idle", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      sample(t(10, 25), CHROME, 300),
      sample(t(10, 40, 5), CODE, 5),
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 20)), idle(t(10, 20), t(10, 40))]);
    expect(state.app).toMatchObject({ name: "Code.exe", since: t(10, 40) });
  });

  it("only goes idle at or above the threshold", () => {
    const { events, state } = run([sample(t(10, 0), CHROME), sample(t(10, 10), CHROME, 299)]);
    expect(events).toEqual([]);
    expect(state.idleSince).toBeNull();
    expect(run([sample(t(10, 0), CHROME), sample(t(10, 10), CHROME, 300)]).state.idleSince).toBe(t(10, 5));
  });

  it("honours a custom threshold", () => {
    const { events } = run([sample(t(10, 0), CHROME), sample(t(10, 2), CHROME, 60)], { idleThresholdSeconds: 60 });
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 1))]);
  });
});

describe("D. app changes while active", () => {
  it("produces one contiguous span per application with no gaps or overlaps", () => {
    const { events } = run([
      sample(t(10, 0), CHROME),
      sample(t(10, 10), CODE),
      sample(t(10, 15), CHROME),
      sample(t(10, 20), CHROME),
      signal("quit", t(10, 30)),
    ]);
    expect(events).toEqual([
      app(CHROME, t(10, 0), t(10, 10)),
      app(CODE, t(10, 10), t(10, 15)),
      app(CHROME, t(10, 15), t(10, 30)),
    ]);
  });
});

describe("E. no foreground application", () => {
  it("closes the open span and stays quiet while nothing is in front", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      sample(t(10, 10), null),
      sample(t(10, 11), null),
      sample(t(10, 12), null),
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10))]);
    expect(state.app).toBeNull();
  });

  it("opens a new span when an app comes back to the front", () => {
    const { events, state } = run([sample(t(10, 0), null), sample(t(10, 5), CODE)]);
    expect(events).toEqual([]);
    expect(state.app).toMatchObject({ name: "Code.exe", since: t(10, 5) });
  });
});

describe("F. lock", () => {
  it("closes the active span at the lock, ignores samples while locked, and resumes after unlock", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      signal("lock", t(10, 10)),
      sample(t(10, 12), CHROME), // still reads the app behind the lock screen
      sample(t(10, 14), CODE),
      signal("unlock", t(10, 20)),
      sample(t(10, 20, 5), CODE),
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10))]);
    expect(state.app).toMatchObject({ name: "Code.exe", since: t(10, 20, 5) });
  });

  it("closes an open idle span at the lock", () => {
    const { events } = run([
      sample(t(10, 0), CHROME),
      sample(t(10, 15), CHROME, 300),
      signal("lock", t(10, 30)),
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10)), idle(t(10, 10), t(10, 30))]);
  });

  it("does not repeat a close when locked twice", () => {
    const { events } = run([sample(t(10, 0), CHROME), signal("lock", t(10, 10)), signal("lock", t(10, 11))]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10))]);
  });
});

describe("G. suspend / resume", () => {
  it("closes the span at suspend and starts nothing until a sample arrives after resume", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      signal("suspend", t(10, 10)),
      signal("resume", t(13, 0)),
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10))]);
    expect(state.app).toBeNull();

    const after = step(state, sample(t(13, 0, 5), CHROME));
    expect(after.state.app).toMatchObject({ name: "chrome.exe", since: t(13, 0, 5) });
  });

  it("ignores samples while suspended, and an unlock does not end a suspend", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      signal("suspend", t(10, 10)),
      sample(t(10, 11), CODE),
      signal("unlock", t(10, 12)),
      sample(t(10, 13), CODE),
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10))]);
    expect(state.app).toBeNull();
    expect(step(step(state, signal("resume", t(10, 20))).state, sample(t(10, 20, 5), CODE)).state.app).toMatchObject({
      name: "Code.exe",
    });
  });

  it("stays paused if the machine resumes while still locked", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      signal("lock", t(10, 5)),
      signal("suspend", t(10, 6)),
      signal("resume", t(11, 0)),
      sample(t(11, 0, 5), CODE), // locked still: ignored
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5))]);
    expect(state.app).toBeNull();
    const unlocked = step(step(state, signal("unlock", t(11, 1))).state, sample(t(11, 1, 5), CODE));
    expect(unlocked.state.app).toMatchObject({ name: "Code.exe", since: t(11, 1, 5) });
  });

  it("does not credit a stale OS idle reading across the sleep to the time before it", () => {
    // Windows may report a long idle right after waking. Idle can only start
    // from the resume, never from before the tracker was looking.
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      signal("suspend", t(10, 10)),
      signal("resume", t(13, 0)),
      sample(t(13, 0, 5), CHROME, 9000),
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10))]);
    expect(state.idleSince).toBe(t(13, 0));
  });
});

describe("H. quit", () => {
  it("closes an open app span at the quit time", () => {
    const { events, state } = run([sample(t(10, 0), CHROME), signal("quit", t(10, 45))]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 45))]);
    expect(state.app).toBeNull();
    expect(state.idleSince).toBeNull();
  });

  it("closes an open idle span at the quit time", () => {
    const { events } = run([sample(t(10, 0), CHROME), sample(t(10, 15), CHROME, 300), signal("quit", t(10, 45))]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10)), idle(t(10, 10), t(10, 45))]);
  });

  it("emits nothing the second time", () => {
    const { events } = run([sample(t(10, 0), CHROME), signal("quit", t(10, 45)), signal("quit", t(10, 46))]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 45))]);
  });

  it("emits nothing when nothing is open", () => {
    expect(run([signal("quit", t(10, 0))]).events).toEqual([]);
  });
});

describe("I. repeated idle samples", () => {
  it("emit nothing while idle continues and keep the original idle start", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      sample(t(10, 15), CHROME, 300),
      sample(t(10, 15, 5), CHROME, 305),
      sample(t(10, 16), CHROME, 360),
      sample(t(10, 30), null, 1200),
    ]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 10))]);
    expect(state.idleSince).toBe(t(10, 10));
  });

  it("clamps idle to what was observed when the tracker starts up already idle", () => {
    // First reading says 40 minutes idle; nothing is claimed from before it.
    const { events, state } = run([sample(t(10, 0), CHROME, 2400)]);
    expect(events).toEqual([]);
    expect(state.idleSince).toBe(t(10, 0));
  });
});

describe("J. no zero or negative durations", () => {
  const durations = (events: ActivityEvent[]) => events.map((e) => e.durationMs);

  it("drops a span closed at the instant it opened", () => {
    const { events } = run([sample(t(10, 0), CHROME), sample(t(10, 0), CODE), sample(t(10, 5), null)]);
    expect(events).toEqual([app(CODE, t(10, 0), t(10, 5))]);
  });

  it("treats a clock that steps backwards as no time passing", () => {
    const { events, state } = run([
      sample(t(10, 10), CHROME),
      sample(t(10, 5), CODE), // clock went back 5 minutes
      sample(t(10, 20), CODE),
    ]);
    expect(events).toEqual([]);
    expect(state.app).toMatchObject({ name: "Code.exe", since: t(10, 10) });
    expect(state.lastAt).toBe(t(10, 20));
  });

  it("never emits a non-positive duration across a messy sequence", () => {
    const { events } = run([
      sample(t(10, 0), CHROME),
      sample(t(10, 0), CHROME, 400),
      sample(t(10, 0), CODE, 0),
      signal("lock", t(10, 0)),
      signal("unlock", t(9, 0)),
      sample(t(9, 30), CHROME, 0),
      signal("suspend", t(10, 0)),
      signal("resume", t(10, 0)),
      sample(t(10, 5), CODE, 1000),
      sample(t(10, 6), CODE, 0),
      signal("quit", t(10, 6)),
    ]);
    expect(durations(events).every((d) => d > 0)).toBe(true);
    for (const e of events) expect(e.endedAt - e.startedAt).toBe(e.durationMs);
  });

  it("ignores a nonsensical idle reading rather than inventing time", () => {
    const { events, state } = run([
      sample(t(10, 0), CHROME),
      sample(t(10, 5), CHROME, Number.NaN),
      sample(t(10, 10), CHROME, -50),
    ]);
    expect(events).toEqual([]);
    expect(state.idleSince).toBeNull();
  });
});

describe("purity", () => {
  it("never mutates the state it is given and is deterministic", () => {
    const start = run([sample(t(10, 0), CHROME)]).state;
    const frozen = JSON.stringify(start);
    const a = step(start, sample(t(10, 30), CODE));
    const b = step(start, sample(t(10, 30), CODE));
    expect(JSON.stringify(start)).toBe(frozen);
    expect(a).toEqual(b);
  });

  it("carries only name and path — no title or other window data", () => {
    const { events } = run([
      sample(t(10, 0), { ...CHROME, title: "Secret doc" } as AppIdentity),
      sample(t(10, 5), CODE),
    ]);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(["durationMs", "endedAt", "kind", "name", "path", "startedAt"]);
  });
});

// ── Rollover ─────────────────────────────────────────────────────────────────
describe("rollover of a long unchanged app span", () => {
  const FIVE = 5 * MIN;
  const ROLL = { idleThresholdSeconds: 300, maxAppSpanMs: FIVE };
  /** Samples every 3s over [from, to], inclusive, all reading `appId` with the given idle. */
  const every3s = (appId: AppIdentity, from: number, to: number, idleSeconds = 0) => {
    const out: TrackerInput[] = [];
    for (let at = from; at <= to; at += 3_000) out.push(sample(at, appId, idleSeconds));
    return out;
  };
  const total = (events: ActivityEvent[], kind: "app" | "idle") =>
    events.filter((e) => e.kind === kind).reduce((n, e) => n + e.durationMs, 0);

  it("A. 15 continuous minutes of Chrome become three exact 5-minute spans, no idle, 15 minutes of active time", () => {
    const { events } = run([...every3s(CHROME, t(10, 0), t(10, 15)), signal("quit", t(10, 15))], ROLL);
    expect(events).toEqual([
      app(CHROME, t(10, 0), t(10, 5)),
      app(CHROME, t(10, 5), t(10, 10)),
      app(CHROME, t(10, 10), t(10, 15)),
    ]);
    expect(total(events, "app")).toBe(15 * MIN);
    expect(total(events, "idle")).toBe(0);
  });

  it("closes at the exact boundary, not at the sample that noticed, and carries the remainder into the next span", () => {
    const { events, state } = run([sample(t(10, 0), CHROME), sample(t(10, 5, 2), CHROME)], ROLL);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5))]);
    expect(state.app?.since).toBe(t(10, 5)); // the same instant — the pieces abut exactly
  });

  it("is invisible to the timeline: same app throughout, no idle, no gap, durations sum to the whole", () => {
    const { events } = run([...every3s(CHROME, t(10, 0), t(10, 17, 30)), signal("quit", t(10, 17, 30))], ROLL);
    expect(events.every((e) => e.kind === "app" && e.name === "chrome.exe")).toBe(true);
    for (let i = 1; i < events.length; i++) expect(events[i]!.startedAt).toBe(events[i - 1]!.endedAt);
    expect(total(events, "app")).toBe(17.5 * MIN);
  });

  it("G. repeated samples inside the interval create no spans", () => {
    const { events, state } = run(every3s(CHROME, t(10, 0), t(10, 4, 57)), ROLL);
    expect(events).toEqual([]);
    expect(state.app?.since).toBe(t(10, 0));
  });

  it("is off unless asked for: the same samples with no option roll nothing", () => {
    const { events } = run([...every3s(CHROME, t(10, 0), t(10, 15)), signal("quit", t(10, 15))]);
    expect(events).toEqual([app(CHROME, t(10, 0), t(10, 15))]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("treats maxAppSpanMs=%s as off", (bad) => {
    const { events } = run([sample(t(10, 0), CHROME), sample(t(10, 30), CHROME)], { idleThresholdSeconds: 300, maxAppSpanMs: bad });
    expect(events).toEqual([]);
  });

  describe("B. an app switch around a rollover", () => {
    it("a switch just before the boundary is one short span, no roll", () => {
      const { events } = run([...every3s(CHROME, t(10, 0), t(10, 4, 57)), sample(t(10, 4, 57), CODE)], ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 4, 57))]);
    });

    it("a switch just after the boundary closes the open span at the switch", () => {
      const { events, state } = run([...every3s(CHROME, t(10, 0), t(10, 4, 57)), sample(t(10, 5, 3), CODE)], ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5, 3))]);
      expect(state.app).toMatchObject({ name: "Code.exe", since: t(10, 5, 3) });
    });

    it("a switch after a roll closes only the remainder, and the pieces still sum to the whole", () => {
      const { events } = run([...every3s(CHROME, t(10, 0), t(10, 7)), sample(t(10, 7, 3), CODE), signal("quit", t(10, 9))], ROLL);
      expect(events).toEqual([
        app(CHROME, t(10, 0), t(10, 5)),
        app(CHROME, t(10, 5), t(10, 7, 3)),
        app(CODE, t(10, 7, 3), t(10, 9)),
      ]);
    });

    it("switching back and forth never rolls (each stay is shorter than the interval)", () => {
      const { events } = run(
        [sample(t(10, 0), CHROME), sample(t(10, 4), CODE), sample(t(10, 8), CHROME), sample(t(10, 12), CODE)],
        ROLL,
      );
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 4)), app(CODE, t(10, 4), t(10, 8)), app(CHROME, t(10, 8), t(10, 12))]);
    });
  });

  describe("C. idle before the rollover", () => {
    it("closes at the idle start, rolls nothing, and measures the next span from the return", () => {
      const { events, state } = run(
        [
          sample(t(10, 0), CHROME),
          sample(t(10, 3), CHROME),
          sample(t(10, 8), CHROME, 300), // last input 10:03
          sample(t(10, 20, 5), CHROME, 5), // back at 10:20:00
        ],
        ROLL,
      );
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 3)), idle(t(10, 3), t(10, 20))]);
      expect(state.app?.since).toBe(t(10, 20));
    });

    it("does not bank time the user was already quiet for: no roll until a real input verifies it", () => {
      // At 10:05 the last input was 10:03 (120s ago, under the idle threshold). Rolling at
      // 10:05 would commit 10:03-10:05 as active; the idle that follows backdates to 10:03.
      const { events } = run(
        [sample(t(10, 0), CHROME), sample(t(10, 5), CHROME, 120), sample(t(10, 8), CHROME, 300)],
        ROLL,
      );
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 3))]);
    });

    it("rolls up to the last input once input resumes (catching up exactly)", () => {
      const { events, state } = run([sample(t(10, 0), CHROME), sample(t(10, 5), CHROME, 120), sample(t(10, 6), CHROME, 0)], ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5))]);
      expect(state.app?.since).toBe(t(10, 5));
    });
  });

  describe("D. idle spanning a rollover boundary", () => {
    const inputs = [
      sample(t(10, 0), CHROME),
      sample(t(10, 4), CHROME),
      sample(t(10, 9), CHROME, 300), // idle from 10:04, which is inside the first interval
      sample(t(10, 12), CHROME, 540), // still idle across 10:05 and 10:10
      sample(t(10, 30, 5), CHROME, 5), // back at 10:30:00
    ];

    it("emits one app span up to the idle start, one idle span across the boundary, and no app time in between", () => {
      const { events } = run(inputs, ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 4)), idle(t(10, 4), t(10, 30))]);
    });

    it("counts the next boundary from the return, not from the old span", () => {
      const { events } = run([...inputs, ...every3s(CHROME, t(10, 30, 8), t(10, 36)), signal("quit", t(10, 36))], ROLL);
      expect(events.slice(2)).toEqual([app(CHROME, t(10, 30), t(10, 35)), app(CHROME, t(10, 35), t(10, 36))]);
    });
  });

  describe("E. lock / suspend around a rollover", () => {
    it("a lock after a roll closes only the remainder", () => {
      const { events } = run([...every3s(CHROME, t(10, 0), t(10, 5)), signal("lock", t(10, 7))], ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5)), app(CHROME, t(10, 5), t(10, 7))]);
    });

    it("a lock before the boundary closes at the lock, and the clock restarts at unlock", () => {
      const { events, state } = run(
        [
          ...every3s(CHROME, t(10, 0), t(10, 4, 57)),
          signal("lock", t(10, 4, 58)),
          signal("unlock", t(10, 20)),
          sample(t(10, 20, 3), CHROME),
          sample(t(10, 25, 3), CHROME), // 5 min after the REOPEN, not after 10:00
        ],
        ROLL,
      );
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 4, 58)), app(CHROME, t(10, 20, 3), t(10, 25, 3))]);
      expect(state.app?.since).toBe(t(10, 25, 3));
    });

    it("suspend and resume restart the interval; samples while suspended roll nothing", () => {
      const { events } = run(
        [
          sample(t(10, 0), CHROME),
          signal("suspend", t(10, 3)),
          sample(t(10, 20), CHROME), // ignored
          signal("resume", t(10, 30)),
          sample(t(10, 30, 3), CHROME),
          signal("quit", t(10, 32)),
        ],
        ROLL,
      );
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 3)), app(CHROME, t(10, 30, 3), t(10, 32))]);
    });

    it("stays paused while still locked even after a resume", () => {
      const { events } = run(
        [sample(t(10, 0), CHROME), signal("lock", t(10, 2)), signal("suspend", t(10, 3)), signal("resume", t(10, 4)), sample(t(10, 40), CHROME)],
        ROLL,
      );
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 2))]);
    });
  });

  describe("F. quit after a rollover", () => {
    it("closes the open remainder and reports every piece exactly once", () => {
      const { events, state } = run([...every3s(CHROME, t(10, 0), t(10, 8)), signal("quit", t(10, 8))], ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5)), app(CHROME, t(10, 5), t(10, 8))]);
      expect(state.app).toBeNull();
      expect(run([signal("quit", t(10, 9))], ROLL).events).toEqual([]);
    });

    it("a quit exactly on the boundary adds no empty span", () => {
      const { events } = run([...every3s(CHROME, t(10, 0), t(10, 5)), signal("quit", t(10, 5))], ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5))]);
    });

    it("an unclean exit loses at most the current instalment: everything rolled is already out", () => {
      const { events } = run(every3s(CHROME, t(10, 0), t(10, 12)), ROLL); // never quit
      expect(total(events, "app")).toBe(10 * MIN); // of 12 continuous minutes, 10 delivered
    });
  });

  describe("stalls and odd clocks", () => {
    it("a long gap between samples rolls every boundary it crossed, exactly", () => {
      const { events, state } = run([sample(t(10, 0), CHROME), sample(t(10, 12, 30), CHROME)], ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5)), app(CHROME, t(10, 5), t(10, 10))]);
      expect(state.app?.since).toBe(t(10, 10));
    });

    it("caps how many spans one sample emits after an enormous gap, and loses nothing", () => {
      const tiny = { idleThresholdSeconds: 300, maxAppSpanMs: 1_000 };
      const first = step(step(initialState, sample(BASE, CHROME), tiny).state, sample(BASE + 400_000, CHROME), tiny);
      expect(first.events).toHaveLength(288);
      const second = step(first.state, sample(BASE + 400_000, CHROME), tiny);
      expect(second.events).toHaveLength(112);
      expect(total([...first.events, ...second.events], "app")).toBe(400_000);
    });

    it("a clock that steps back does not undo or repeat a roll", () => {
      const { events, state } = run([sample(t(10, 0), CHROME), sample(t(10, 6), CHROME), sample(t(10, 2), CHROME)], ROLL);
      expect(events).toEqual([app(CHROME, t(10, 0), t(10, 5))]);
      expect(state.app?.since).toBe(t(10, 5));
    });
  });

  describe("H. no zero or negative durations, no overlap, nothing counted twice", () => {
    it("holds across a deterministic fuzz of samples, switches, idle and lifecycle signals", () => {
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
      const apps = [CHROME, CODE];
      const inputs: TrackerInput[] = [];
      let now = t(10, 0);
      for (let i = 0; i < 3000; i++) {
        now += Math.floor(rnd() * 4_000) - 300; // mostly forward, occasionally back a little
        const roll = rnd();
        if (roll < 0.01) inputs.push(signal("lock", now));
        else if (roll < 0.02) inputs.push(signal("unlock", now));
        else if (roll < 0.03) inputs.push(signal("suspend", now));
        else if (roll < 0.04) inputs.push(signal("resume", now));
        else {
          const idleS = rnd() < 0.05 ? 300 + Math.floor(rnd() * 600) : Math.floor(rnd() * 20);
          inputs.push(sample(now, rnd() < 0.05 ? null : apps[rnd() < 0.1 ? 1 : 0]!, idleS));
        }
        if (rnd() < 0.002) now += 20 * MIN; // a stall
      }
      inputs.push(signal("quit", now));
      const { events } = run(inputs, { idleThresholdSeconds: 300, maxAppSpanMs: MIN });

      expect(events.length).toBeGreaterThan(20);
      for (const e of events) {
        expect(e.durationMs).toBeGreaterThan(0);
        expect(e.endedAt - e.startedAt).toBe(e.durationMs);
      }
      const sorted = [...events].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.startedAt).toBeGreaterThanOrEqual(sorted[i - 1]!.endedAt);
    });
  });
});
