/**
 * Ringtone lifecycle. The tone itself can't be asserted (jsdom has no audio
 * engine), so these cover the parts that break calls if they regress: a ring
 * that keeps looping after the call ends, a double-start stacking two tones on
 * top of each other, and a host with no Web Audio at all taking the call down
 * with it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

class FakeParam {
  value = 1;
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
  linearRampToValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
}

class FakeNode {
  disconnected = 0;
  connect(dest: FakeNode) {
    return dest;
  }
  disconnect() {
    this.disconnected += 1;
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeOsc extends FakeNode {
  type = "sine";
  frequency = new FakeParam();
  started = false;
  stopped = 0;
  onended: (() => void) | null = null;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped += 1;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** "running" = the page is activated; "suspended" = needs a resume();
   *  "blocked" = the browser refuses to resume at all (no user gesture). */
  static initialState: "running" | "suspended" | "blocked" = "running";
  currentTime = 0;
  state: string;
  destination = new FakeNode();
  oscillators: FakeOsc[] = [];
  gains: FakeGain[] = [];
  resumed = 0;

  constructor() {
    this.state = FakeAudioContext.initialState === "running" ? "running" : "suspended";
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    const o = new FakeOsc();
    this.oscillators.push(o);
    return o;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: "lowpass", frequency: new FakeParam() });
  }
  resume() {
    this.resumed += 1;
    if (FakeAudioContext.initialState === "blocked") return Promise.reject(new Error("not allowed"));
    this.state = "running";
    return Promise.resolve();
  }
}

/** Stand-in for HTMLAudioElement — the fallback path when audio is blocked. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  static rejectPlay = false;
  loop = false;
  volume = 1;
  paused = true;
  plays = 0;
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
  play() {
    this.plays += 1;
    if (FakeAudio.rejectPlay) return Promise.reject(new Error("blocked"));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

/** Fresh module per test — `ringtone.ts` caches one AudioContext per module. */
async function loadRingtone(withAudio = true) {
  vi.resetModules();
  FakeAudioContext.instances = [];
  FakeAudio.instances = [];
  (window as unknown as { Audio: unknown }).Audio = FakeAudio;
  if (withAudio) {
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  } else {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  }
  return import("./ringtone");
}

const ctx = () => FakeAudioContext.instances[0]!;

describe("createRingtone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudioContext.initialState = "running";
    FakeAudio.rejectPlay = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });

  it("schedules one arpeggio per cycle and keeps looping", async () => {
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();
    // 3 notes × (fundamental + octave partial)
    expect(ctx().oscillators).toHaveLength(6);
    expect(ctx().oscillators.every((o) => o.started)).toBe(true);

    vi.advanceTimersByTime(4000); // one cycle
    expect(ctx().oscillators).toHaveLength(12);

    ring.stop();
  });

  it("is idempotent on start — a second start does not stack a second tone", async () => {
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();
    ring.start();
    expect(ctx().oscillators).toHaveLength(6);

    ring.stop();
  });

  it("stop() silences the loop, kills scheduled voices and releases the chain", async () => {
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("outgoing");

    ring.start();
    const scheduled = ctx().oscillators.length;
    expect(scheduled).toBeGreaterThan(0);
    const master = ctx().gains[0]!;

    ring.stop();
    vi.advanceTimersByTime(200); // past the fade-out

    expect(master.gain.value).toBe(0);
    expect(master.disconnected).toBe(1);
    expect(ctx().oscillators.every((o) => o.stopped > 0)).toBe(true);

    // The interval is gone: no further cycle is ever scheduled.
    vi.advanceTimersByTime(10_000);
    expect(ctx().oscillators).toHaveLength(scheduled);
  });

  it("tolerates stop() without start(), and a repeated stop()", async () => {
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    expect(() => ring.stop()).not.toThrow();
    ring.start();
    ring.stop();
    expect(() => ring.stop()).not.toThrow();
    vi.advanceTimersByTime(500);
  });

  // v1 scheduled onto a suspended context and hoped the resume landed, so a
  // refused resume looked exactly like a working ring. Nothing may be scheduled
  // until the context actually reports "running".
  it("resumes a suspended context BEFORE scheduling anything", async () => {
    FakeAudioContext.initialState = "suspended";
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();
    expect(ctx().resumed).toBe(1);
    expect(ctx().oscillators).toHaveLength(0); // not until the clock is live

    await vi.waitFor(() => expect(ctx().oscillators).toHaveLength(6));
    expect(ctx().state).toBe("running");

    ring.stop();
  });

  it("falls back to an <audio> clip when the browser refuses to resume", async () => {
    FakeAudioContext.initialState = "blocked";
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));

    const el = FakeAudio.instances[0]!;
    expect(el.loop).toBe(true);
    expect(el.src.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(el.plays).toBe(1);
    expect(ctx().oscillators).toHaveLength(0);

    ring.stop();
    expect(el.paused).toBe(true);
  });

  it("does not start ringing if the call ends while the resume is in flight", async () => {
    FakeAudioContext.initialState = "suspended";
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();
    ring.stop(); // answered/declined before resume() settled
    await vi.waitFor(() => expect(ctx().state).toBe("running"));

    expect(ctx().oscillators).toHaveLength(0);
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("is a silent no-op when the host has no Web Audio", async () => {
    const { createRingtone } = await loadRingtone(false);
    const ring = createRingtone("incoming");

    expect(() => ring.start()).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(() => ring.stop()).not.toThrow();
  });
});

describe("primeRingtoneAudio", () => {
  beforeEach(() => {
    FakeAudioContext.initialState = "suspended";
  });
  afterEach(() => {
    FakeAudioContext.initialState = "running";
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });

  it("unlocks the context on a gesture, then stops listening", async () => {
    const { primeRingtoneAudio } = await loadRingtone();
    const off = primeRingtoneAudio();

    window.dispatchEvent(new Event("pointerdown"));
    expect(ctx().resumed).toBe(1);
    await vi.waitFor(() => expect(ctx().state).toBe("running"));

    // Unlocked — further gestures cost nothing.
    window.dispatchEvent(new Event("pointerdown"));
    expect(ctx().resumed).toBe(1);

    expect(() => off()).not.toThrow();
  });

  // The regression: v1 listened with {once:true}, so a gesture that arrived
  // while the browser was still refusing burned the only attempt and the app
  // stayed muted for the rest of the session.
  it("keeps trying on later gestures while the browser still refuses", async () => {
    FakeAudioContext.initialState = "blocked";
    const { primeRingtoneAudio } = await loadRingtone();
    const off = primeRingtoneAudio();

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(new Event("click"));

    expect(ctx().resumed).toBeGreaterThanOrEqual(3);
    off();
  });
});
