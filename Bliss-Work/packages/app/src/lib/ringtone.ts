/** Call ringtones, synthesized at runtime.
 *
 *  Deliberately no audio asset: the tone is generated in code, so the identical
 *  thing works in the web bundle and in the packaged Electron renderer (whose
 *  CSP is generated from API origins and has no media-src for a hosted sound),
 *  costs nothing in bundle size, and needs no licence.
 *
 *  ── Why an <audio> element is the PRIMARY path ─────────────────────────────
 *  Browsers block sound in a document that has no user activation, and a call
 *  arriving at an idle tab is exactly that. The one thing that survives it is a
 *  media element that has ALREADY been played once during a real gesture:
 *  Chrome and Safari track activation per element, so a blessed element may be
 *  replayed later without a fresh gesture. So we prime one element per voice on
 *  the user's first interaction (play muted, then pause) and reuse it forever.
 *  Web Audio remains as the fallback for hosts where that fails.
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
 *  gesture, and a call arriving at an idle tab is precisely the case with no
 *  recent gesture — the first version of this listened for ONE gesture and gave
 *  up, which is why the ring was silent in production.
 *
 *  So: keep listening on EVERY interaction until the context actually reports
 *  "running", and create it during the gesture (a context constructed while the
 *  page is activated starts unlocked, where a later resume() would be refused).
 *  Returns an unsubscribe for React cleanup. */
export function primeRingtoneAudio(): () => void {
  if (typeof window === "undefined") return () => {};
  const events = ["pointerdown", "pointerup", "keydown", "touchstart", "click"] as const;

  const wake = () => {
    blessElements();
    const ac = audioContext();
    if (ac && ac.state !== "running") void ac.resume().catch(() => {});
    // Stop listening only once there is something that can actually ring.
    if (blessed.size === Object.keys(VOICES).length) off();
  };
  const off = () => events.forEach((e) => window.removeEventListener(e, wake));
  events.forEach((e) => window.addEventListener(e, wake, { passive: true }));
  wake(); // the document may already be activated (a click got us here)
  return off;
}

/** Elements that have been played once under a gesture, keyed by voice. */
const blessed = new Map<RingKind, HTMLAudioElement>();
let blessing = false;

/** Play each voice muted and immediately pause it, inside the gesture that got
 *  us here. That is what marks the element as user-activated; afterwards it can
 *  be played on an incoming call with no gesture of its own. */
function blessElements() {
  if (blessing || typeof Audio === "undefined") return;
  blessing = true;
  for (const kind of Object.keys(VOICES) as RingKind[]) {
    if (blessed.has(kind)) continue;
    try {
      const el = new Audio(clipFor(kind));
      el.loop = true;
      el.preload = "auto";
      el.volume = 0;
      const done = el.play();
      const bless = () => {
        el.pause();
        el.currentTime = 0;
        el.volume = 1;
        blessed.set(kind, el);
      };
      if (done && typeof done.then === "function") {
        void done.then(bless).catch(() => {});
      } else {
        bless();
      }
    } catch {
      /* no media support — the Web Audio fallback still has a chance */
    }
  }
  blessing = false;
}

// ── WAV fallback ────────────────────────────────────────────────────────────
// When the AudioContext cannot be resumed, an <audio> element is a genuine
// second chance: Chrome gates media elements on the site's media-engagement
// score as well as on activation, so a site the user works in all day is often
// allowed to play where a fresh AudioContext is not. The clip is rendered from
// the SAME voice table, so both paths sound identical.

const RATE = 22050;

/** Renders one cycle of `voice` to mono float samples. */
function renderCycle(voice: Voice): Float32Array {
  const out = new Float32Array(Math.round(voice.cycle * RATE));
  for (const [offset, freq] of voice.notes) {
    for (const [f, peak] of [
      [freq, voice.gain],
      [freq * 2, voice.gain * 0.25],
    ] as [number, number][]) {
      const from = Math.round(offset * RATE);
      const len = Math.round(voice.decay * RATE);
      for (let i = 0; i < len && from + i < out.length; i++) {
        const t = i / RATE;
        // Same shape as the node graph: 90ms attack, exponential decay tail.
        const env = t < 0.09 ? t / 0.09 : Math.exp(-(t - 0.09) * (5 / voice.decay));
        out[from + i]! += Math.sin(2 * Math.PI * f * t) * peak * env;
      }
    }
  }
  return out;
}

/** Wraps PCM samples in a 16-bit mono WAV container as a data: URI. */
function wavDataUri(samples: Float32Array): string {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s * 0x7fff, true);
  }
  let bin = "";
  const raw = new Uint8Array(bytes);
  for (let i = 0; i < raw.length; i += 0x8000) {
    bin += String.fromCharCode(...raw.subarray(i, i + 0x8000));
  }
  return `data:audio/wav;base64,${btoa(bin)}`;
}

const clipCache = new Map<RingKind, string>();

function clipFor(kind: RingKind): string {
  let uri = clipCache.get(kind);
  if (!uri) {
    uri = wavDataUri(renderCycle(VOICES[kind]));
    clipCache.set(kind, uri);
  }
  return uri;
}

export interface Ringtone {
  /** Begin looping. Idempotent — a second call while playing is a no-op. */
  start: () => void;
  /** Fade out and release the nodes. Idempotent; safe to call when never started. */
  stop: () => void;
}

/** Builds a looping ringtone. One instance drives one call.
 *  `onBlocked` fires when every path was refused, so the UI can say so rather
 *  than leaving the user wondering why a call is silent. */
export function createRingtone(kind: RingKind, onBlocked?: () => void): Ringtone {
  const voice = VOICES[kind];
  let timer: ReturnType<typeof setInterval> | undefined;
  let master: GainNode | undefined;
  let live: OscillatorNode[] = [];
  let nextAt = 0;
  let element: HTMLAudioElement | undefined;
  // Set by stop(): resume() is async, so a call answered inside that window
  // must not start a ring nobody can hear the end of.
  let stopped = false;

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

  /** Play through a media element — the blessed one if we have it. */
  const playElement = (onFail: () => void) => {
    if (stopped || element || typeof Audio === "undefined") return onFail();
    let el = blessed.get(kind);
    try {
      if (!el) {
        el = new Audio(clipFor(kind));
        el.loop = true;
      }
      el.volume = 1;
      el.currentTime = 0;
      element = el;
      const done = el.play();
      if (done && typeof done.then === "function") {
        void done.catch(() => {
          element = undefined;
          onFail();
        });
      }
    } catch {
      element = undefined;
      onFail();
    }
  };

  /** Every path refused. The call still rings visually — never throw over it. */
  const giveUp = () => {
    if (stopped) return;
    onBlocked?.();
  };

  /** Schedules the looping arpeggio on the (now running) context. */
  const scheduleOn = (ac: AudioContext) => {
    if (stopped || timer || !ensureChain(ac)) return;
    const cycle = () => {
      if (!master) return;
      nextAt = Math.max(nextAt, ac.currentTime + 0.02);
      for (const [offset, freq] of voice.notes) strike(ac, master, freq, nextAt + offset, voice.gain);
      nextAt += voice.cycle;
    };
    cycle();
    timer = setInterval(cycle, voice.cycle * 1000);
  };

  /** Web Audio: only ever schedule onto a context that is really running — a
   *  refused resume must be detected, not scheduled over and hoped about. */
  const playWebAudio = (onFail: () => void) => {
    const ac = audioContext();
    if (!ac) return onFail();
    if (ac.state === "running") return scheduleOn(ac);
    void ac
      .resume()
      .then(() => (ac.state === "running" ? scheduleOn(ac) : onFail()))
      .catch(onFail);
  };

  const start = () => {
    if (timer || element) return;
    stopped = false;
    // Element first: it is the only path that survives a document with no
    // recent gesture, provided it was blessed at login. Web Audio second.
    playElement(() => playWebAudio(giveUp));
  };

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (element) {
      try {
        element.pause();
        element.currentTime = 0;
        // A blessed element is kept (and stays blessed) for the next call; only
        // an ad-hoc one is released.
        if (blessed.get(kind) !== element) element.src = "";
      } catch {
        /* already released */
      }
      element = undefined;
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
