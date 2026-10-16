import { TrackEvent, type LocalAudioTrack } from "livekit-client";
import { logger } from "@taskboard/shared";
import { AUDIO_CAPTURE_DEFAULTS } from "./mediaConstraints";

/**
 * Reports what the browser is ACTUALLY doing to a captured microphone track.
 *
 * `noiseSuppression: true` in AUDIO_CAPTURE_DEFAULTS is a request, and a request
 * proves nothing: a browser (or a driver, or a Bluetooth headset profile) is free
 * to ignore it. Three different questions have three different sources here:
 *
 *   requested — AUDIO_CAPTURE_DEFAULTS, the one shared config.
 *   supported — navigator.mediaDevices.getSupportedConstraints(): does this
 *               browser know the constraint at all.
 *   effective — track.getSettings(): what the live track reports it is applying.
 *               Not track.getConstraints(), which only echoes the request back.
 *
 * `effective` is what the browser SAYS; it is not proof the noise is gone. That
 * needs a real microphone and a listener.
 *
 * Carries capability flags only — never a deviceId, a label, or anything derived
 * from the audio itself. Never throws: a diagnostic must not be able to end a call.
 */

type SharedSetting = keyof typeof AUDIO_CAPTURE_DEFAULTS;

/** Not part of the shared config, and not in this TypeScript's lib.dom either.
 *  livekit-client requests it by default for meetings (its own audioDefaults),
 *  so it is reported — informationally, it never counts as "not applied". */
const EXTRA_SETTINGS = ["voiceIsolation"] as const;

export interface MicSettingStatus {
  /** Undefined for a setting that is not in the shared config. */
  requested?: boolean;
  supported?: boolean;
  /** Undefined = the browser does not report this setting at all. */
  effective?: boolean;
}

export interface MicProcessingReport {
  settings: Record<string, MicSettingStatus>;
  /** Requested, but the live track reports it OFF. */
  notApplied: string[];
  /** Requested, but the browser does not say either way. */
  unreported: string[];
}

export function inspectMicProcessing(track: MediaStreamTrack): MicProcessingReport | null {
  try {
    if (typeof track.getSettings !== "function") return null;
    const effective = track.getSettings() as Record<string, unknown>;
    const supported = (navigator.mediaDevices?.getSupportedConstraints?.() ?? {}) as Record<string, unknown>;
    const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);

    const settings: Record<string, MicSettingStatus> = {};
    const notApplied: string[] = [];
    const unreported: string[] = [];
    for (const name of Object.keys(AUDIO_CAPTURE_DEFAULTS) as SharedSetting[]) {
      const requested = AUDIO_CAPTURE_DEFAULTS[name];
      const eff = flag(effective[name]);
      settings[name] = { requested, supported: flag(supported[name]), effective: eff };
      if (requested && eff === false) notApplied.push(name);
      else if (requested && eff === undefined) unreported.push(name);
    }
    for (const name of EXTRA_SETTINGS) {
      settings[name] = { supported: flag(supported[name]), effective: flag(effective[name]) };
    }
    return { settings, notApplied, unreported };
  } catch {
    return null;
  }
}

/** Log the report for `track`. `where` says which path and moment, e.g.
 *  "call:acquired" or "meeting:restarted". debug normally; warn only when a
 *  requested setting is definitely OFF, which is the one case worth noticing. */
export function logMicProcessing(where: string, track: MediaStreamTrack | undefined): void {
  if (!track) return;
  const report = inspectMicProcessing(track);
  if (!report) return;
  logger.debug(`[MIC] ${where}`, report);
}

const watched = new WeakSet<LocalAudioTrack>();

/**
 * Report on a LiveKit-owned microphone now, and again every time LiveKit
 * re-acquires it (device switch, unplug, stop-on-mute) — the moments the
 * constraints are applied afresh and could have been lost.
 *
 * Idempotent per track, since LocalTrackPublished can fire again for a track
 * that is being republished, and a second listener would log every restart twice.
 */
export function watchLivekitMic(track: LocalAudioTrack): void {
  if (watched.has(track)) return;
  watched.add(track);
  logMicProcessing("meeting:published", track.mediaStreamTrack);
  track.on(TrackEvent.Restarted, () => logMicProcessing("meeting:restarted", track.mediaStreamTrack));
}
