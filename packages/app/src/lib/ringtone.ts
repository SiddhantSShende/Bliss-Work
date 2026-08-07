/** Call ringtones, synthesized with Web Audio.
 *
 *  Deliberately no audio asset: the tone is built from oscillators at runtime,
 *  so the identical code works in the web bundle and in the packaged Electron
 *  renderer (whose CSP is generated from API origins and has no media-src for a
 *  hosted sound), costs nothing in bundle size, and needs no licence.
 *
 *  Two voices:
 *    • "incoming" — a warm bell arpeggio (A4 → C#5 → E5, each with a quiet
 *      octave partial for shimmer), slow attack and long exponential release
 *      through a low-pass, then a rest. Smooth rather than strident.
 *    • "outgoing" — a much quieter two-pulse ringback so the caller knows the
 *      invite actually went out while "Calling…" is on screen.
 */

export type RingKind = "incoming" | "outgoing";

interface Voice {
  /** [offsetSeconds, frequencyHz] pairs making up one cycle. */
  notes: [number, number][];
  /** Length of one note's decay tail, seconds. */
  decay: number;
  /** Peak gain of a single note (the octave partial rides at a quarter of it). */
  gain: number;
  /** Full cycle length including the rest, seconds. */
  cycle: number;
  /** Low-pass corner — rounds the edges off the sine stack. */
  cutoff: number;
}

const VOICES: Record<RingKind, Voice> = {
  // A4 · C#5 · E5 — a major triad, which reads as pleasant rather than urgent.
  incoming: { notes: [[0, 440], [0.26, 554.37], [0.52, 659.25]], decay: 1.5, gain: 0.12, cycle: 4, cutoff: 2000 },
  outgoing: { notes: [[0, 420], [0.36, 420]], decay: 0.5, gain: 0.045, cycle: 3, cutoff: 1200 },
};

const STOP_RAMP = 0.08; // seconds — fade out, never a click

let shared: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!shared) {
    try {
      shared = new Ctor();
    } catch {
      return null; // audio unavailable (headless / blocked) — calls still work
    }
  }
  return shared;
}

/** Browsers keep an AudioContext suspended until the page has seen a user
 *  gesture, so a ringtone for a call that arrives while the tab is idle would
 *  be silent. Resume on the first interaction after login and the context stays
 *  unlocked for the session. Returns an unsubscribe for React cleanup. */
export function primeRingtoneAudio(): () => void {
  if (typeof window === "undefined") return () => {};
  const events = ["pointerdown", "keydown", "touchstart"] as const;
  const wake = () => {
    void audioContext()?.resume().catch(() => {});
    off();
  };
  const off = () => events.forEach((e) => window.removeEventListener(e, wake));
  events.forEach((e) => window.addEventListener(e, wake, { once: true, passive: true }));
  return off;
}

export interface Ringtone {
  /** Begin looping. Idempotent — a second call while playing is a no-op. */
  start: () => void;
  /** Fade out and release the nodes. Idempotent; safe to call when never started. */
  stop: () => void;
}

/** Builds a looping ringtone. One instance drives one call. */
export function createRingtone(kind: RingKind): Ringtone {
  const voice = VOICES[kind];
  let timer: ReturnType<typeof setInterval> | undefined;
  let master: GainNode | undefined;
  let live: OscillatorNode[] = [];
  let nextAt = 0;

  /** One bell: sine + quarter-gain octave partial, soft attack, long tail. */
  const strike = (ac: AudioContext, dest: AudioNode, freq: number, at: number, gain: number) => {
    const partials: [number, number][] = [
      [freq, gain],
      [freq * 2, gain * 0.25], // octave shimmer, well under the fundamental
    ];
    for (const [f, g] of partials) {
      const osc = ac.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f, at);
      const env = ac.createGain();
      // exponentialRamp can't touch zero — start/end just above silence.
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(g, at + 0.09);
      env.gain.exponentialRampToValueAtTime(0.0001, at + voice.decay);
      osc.connect(env).connect(dest);
      osc.start(at);
      osc.stop(at + voice.decay + 0.05);
      osc.onended = () => {
        live = live.filter((o) => o !== osc);
      };
      live.push(osc);
    }
  };

  /** Lazily builds master gain → low-pass → speakers. Returns false if audio
   *  is unavailable, so start() can bail without leaving a timer behind. */
  const ensureChain = (ac: AudioContext): boolean => {
    if (master) return true;
    try {
      const g = ac.createGain();
      g.gain.setValueAtTime(1, ac.currentTime);
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(voice.cutoff, ac.currentTime);
      g.connect(lp).connect(ac.destination);
      master = g;
      nextAt = 0;
      return true;
    } catch {
      return false;
    }
  };

  const start = () => {
    if (timer) return;
    const ac = audioContext();
    if (!ac || !ensureChain(ac)) return;
    // A suspended context schedules fine but stays silent; resuming is
    // best-effort — a blocked ringtone must never break the call itself.
    void ac.resume().catch(() => {});
    const cycle = () => {
      if (!master) return;
      nextAt = Math.max(nextAt, ac.currentTime + 0.02);
      for (const [offset, freq] of voice.notes) strike(ac, master, freq, nextAt + offset, voice.gain);
      nextAt += voice.cycle;
    };
    cycle();
    timer = setInterval(cycle, voice.cycle * 1000);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    const ac = shared;
    const g = master;
    master = undefined;
    if (!ac || !g) return;
    const now = ac.currentTime;
    try {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + STOP_RAMP);
    } catch {
      /* a context torn down under us — the disconnect below is enough */
    }
    const stopping = live;
    live = [];
    setTimeout(() => {
      for (const osc of stopping) {
        try {
          osc.stop();
        } catch {
          /* already ended */
        }
      }
      try {
        g.disconnect();
      } catch {
        /* already detached */
      }
    }, STOP_RAMP * 1000 + 20);
  };

  return { start, stop };
}
