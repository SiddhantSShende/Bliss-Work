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
  currentTime = 0;
  state = "running";
  destination = new FakeNode();
  oscillators: FakeOsc[] = [];
  gains: FakeGain[] = [];
  resumed = 0;

  constructor() {
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
    return Promise.resolve();
  }
}

/** Fresh module per test — `ringtone.ts` caches one AudioContext per module. */
async function loadRingtone(withAudio = true) {
  vi.resetModules();
  FakeAudioContext.instances = [];
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
  beforeEach(() => vi.useFakeTimers());
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

  it("is a silent no-op when the host has no Web Audio", async () => {
    const { createRingtone } = await loadRingtone(false);
    const ring = createRingtone("incoming");

    expect(() => ring.start()).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(() => ring.stop()).not.toThrow();
  });
});

describe("primeRingtoneAudio", () => {
  afterEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });

  it("resumes the context on the first gesture, then unsubscribes", async () => {
    const { primeRingtoneAudio } = await loadRingtone();
    const off = primeRingtoneAudio();

    window.dispatchEvent(new Event("pointerdown"));
    expect(ctx().resumed).toBe(1);

    window.dispatchEvent(new Event("pointerdown"));
    expect(ctx().resumed).toBe(1);

    expect(() => off()).not.toThrow();
  });
});
