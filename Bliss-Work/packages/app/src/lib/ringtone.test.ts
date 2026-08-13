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
  scheduledWhileSuspended = false;

  constructor() {
    this.state = FakeAudioContext.initialState === "running" ? "running" : "suspended";
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    // Scheduling onto a context that is not running is the v1 bug: it makes a
    // refused resume look like a working ring.
    if (this.state !== "running") this.scheduledWhileSuspended = true;
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

  it("rings through a media element — the path that survives an idle tab", async () => {
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();

    expect(FakeAudio.instances).toHaveLength(1);
    const el = FakeAudio.instances[0]!;
    expect(el.loop).toBe(true);
    expect(el.src.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(el.plays).toBe(1);
    // Web Audio is the fallback, so it must not even be constructed.
    expect(FakeAudioContext.instances).toHaveLength(0);

    ring.stop();
    expect(el.paused).toBe(true);
  });

  it("is idempotent on start — a second start does not stack a second tone", async () => {
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();
    ring.start();

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]!.plays).toBe(1);
    ring.stop();
  });

  it("falls back to the Web Audio arpeggio when the element is refused", async () => {
    FakeAudio.rejectPlay = true;
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();

    // 3 notes x (fundamental + octave partial), once the element rejects.
    await vi.waitFor(() => expect(ctx().oscillators).toHaveLength(6));
    expect(ctx().oscillators.every((o) => o.started)).toBe(true);

    vi.advanceTimersByTime(4000); // one cycle later, the loop has struck again
    expect(ctx().oscillators).toHaveLength(12);

    ring.stop();
  });

  it("stop() silences the fallback loop and releases the chain", async () => {
    FakeAudio.rejectPlay = true;
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("outgoing");

    ring.start();
    await vi.waitFor(() => expect(ctx().oscillators.length).toBeGreaterThan(0));
    const scheduled = ctx().oscillators.length;
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
    FakeAudio.rejectPlay = true;
    FakeAudioContext.initialState = "suspended";
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();
    expect(FakeAudioContext.instances).toHaveLength(0); // nothing synchronous

    await vi.waitFor(() => expect(ctx().oscillators).toHaveLength(6));
    expect(ctx().resumed).toBe(1);
    expect(ctx().state).toBe("running");
    expect(ctx().scheduledWhileSuspended).toBe(false);

    ring.stop();
  });

  it("reports blocked — rather than ringing silently — when every path is refused", async () => {
    FakeAudio.rejectPlay = true;
    FakeAudioContext.initialState = "blocked";
    const { createRingtone } = await loadRingtone();
    const onBlocked = vi.fn();
    const ring = createRingtone("incoming", onBlocked);

    ring.start();

    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1));
    expect(ctx().oscillators).toHaveLength(0);
    ring.stop();
  });

  it("does not start ringing if the call ends while the resume is in flight", async () => {
    FakeAudio.rejectPlay = true;
    FakeAudioContext.initialState = "suspended";
    const { createRingtone } = await loadRingtone();
    const ring = createRingtone("incoming");

    ring.start();
    ring.stop(); // answered/declined before resume() settled
    await vi.waitFor(() => expect(ctx().state).toBe("running"));

    expect(ctx().oscillators).toHaveLength(0);
  });

  it("is a silent no-op when the host has neither Web Audio nor media", async () => {
    const { createRingtone } = await loadRingtone(false);
    delete (window as unknown as { Audio?: unknown }).Audio;
    const ring = createRingtone("incoming");

    expect(() => ring.start()).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(() => ring.stop()).not.toThrow();
    (window as unknown as { Audio: unknown }).Audio = FakeAudio;
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
