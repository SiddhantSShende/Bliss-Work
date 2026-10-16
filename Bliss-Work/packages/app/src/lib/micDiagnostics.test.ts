import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrackEvent, type LocalAudioTrack } from "livekit-client";
import { AUDIO_CAPTURE_DEFAULTS } from "./mediaConstraints";
import { inspectMicProcessing, logMicProcessing, watchLivekitMic } from "./micDiagnostics";

const SHARED = Object.keys(AUDIO_CAPTURE_DEFAULTS);
const allOn = { noiseSuppression: true, echoCancellation: true, autoGainControl: true };

function track(settings: Record<string, unknown>): MediaStreamTrack {
  return { getSettings: () => settings } as unknown as MediaStreamTrack;
}

function stubSupported(supported: Record<string, boolean>) {
  vi.stubGlobal("navigator", { mediaDevices: { getSupportedConstraints: () => supported } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("inspectMicProcessing", () => {
  it("separates requested, supported and effective for every setting in the shared config", () => {
    stubSupported({ noiseSuppression: true, echoCancellation: true, autoGainControl: false });
    const r = inspectMicProcessing(track({ ...allOn, autoGainControl: false }))!;

    expect(Object.keys(r.settings)).toEqual(expect.arrayContaining(SHARED));
    expect(r.settings.noiseSuppression).toEqual({ requested: true, supported: true, effective: true });
    // Requested and unsupported and off: three different facts, all reported.
    expect(r.settings.autoGainControl).toEqual({ requested: true, supported: false, effective: false });
    expect(r.notApplied).toEqual(["autoGainControl"]);
  });

  it("flags a requested setting the live track reports OFF", () => {
    stubSupported({ noiseSuppression: true });
    const r = inspectMicProcessing(track({ ...allOn, noiseSuppression: false }))!;
    expect(r.notApplied).toEqual(["noiseSuppression"]);
    expect(r.unreported).toEqual([]);
  });

  it("treats a setting the browser does not report as unknown, not as off", () => {
    stubSupported({});
    const r = inspectMicProcessing(track({}))!;
    expect(r.notApplied).toEqual([]);
    expect(r.unreported).toEqual(SHARED);
    // Whole-object match: the entry must exist, with only `requested` known.
    expect(r.settings.noiseSuppression).toEqual({ requested: true, supported: undefined, effective: undefined });
  });

  it("reports voiceIsolation informationally and never counts it as not applied", () => {
    stubSupported({ voiceIsolation: true });
    const r = inspectMicProcessing(track({ ...allOn, voiceIsolation: false }))!;
    expect(r.settings.voiceIsolation).toEqual({ supported: true, effective: false });
    expect(r.notApplied).toEqual([]);
  });

  it("carries no device identifiers, labels or other settings", () => {
    stubSupported({ noiseSuppression: true });
    const r = inspectMicProcessing(
      track({ ...allOn, deviceId: "SECRET-DEVICE-ID", groupId: "SECRET-GROUP", label: "SECRET-LABEL", sampleRate: 48000 }),
    )!;
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/SECRET/);
    expect(json).not.toMatch(/sampleRate/);
  });

  it("never throws, whatever the environment lacks", () => {
    stubSupported({});
    expect(inspectMicProcessing({} as MediaStreamTrack)).toBeNull(); // no getSettings
    expect(
      inspectMicProcessing({
        getSettings: () => {
          throw new Error("boom");
        },
      } as unknown as MediaStreamTrack),
    ).toBeNull();

    vi.stubGlobal("navigator", {}); // no mediaDevices at all
    const r = inspectMicProcessing(track(allOn))!;
    expect(r.settings.noiseSuppression).toEqual({ requested: true, supported: undefined, effective: true });
  });
});

describe("logMicProcessing", () => {
  it("logs at debug when everything requested is in effect", () => {
    stubSupported({ noiseSuppression: true });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logMicProcessing("call:acquired", track(allOn));
    expect(debug).toHaveBeenCalledWith("[MIC] call:acquired", expect.objectContaining({ notApplied: [] }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a requested setting mismatch at debug level", () => {
    stubSupported({ noiseSuppression: true });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logMicProcessing("call:acquired", track({ ...allOn, noiseSuppression: false }));
    expect(debug).toHaveBeenCalledWith(
      "[MIC] call:acquired",
      expect.objectContaining({ notApplied: ["noiseSuppression"] }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent for a missing or uninspectable track", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logMicProcessing("call:acquired", undefined);
    logMicProcessing("call:acquired", {} as MediaStreamTrack);
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("watchLivekitMic", () => {
  function livekitTrack(settings: Record<string, unknown>) {
    const t = new EventEmitter() as EventEmitter & { mediaStreamTrack: MediaStreamTrack };
    t.mediaStreamTrack = track(settings);
    return t;
  }

  it("reports on publish, and again on each re-acquire with the NEW underlying track", () => {
    stubSupported({ noiseSuppression: true });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lk = livekitTrack(allOn);

    watchLivekitMic(lk as unknown as LocalAudioTrack);
    expect(debug).toHaveBeenCalledWith("[MIC] meeting:published", expect.anything());

    // A restart swaps mediaStreamTrack; the report must read the replacement
    // rather than the track that was current when the listener was attached.
    lk.mediaStreamTrack = track({ ...allOn, noiseSuppression: false });
    lk.emit(TrackEvent.Restarted);
    expect(debug).toHaveBeenCalledWith(
      "[MIC] meeting:restarted",
      expect.objectContaining({ notApplied: ["noiseSuppression"] }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("attaches only once per track, so a republish does not double every later log", () => {
    stubSupported({ noiseSuppression: true });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const lk = livekitTrack(allOn);

    watchLivekitMic(lk as unknown as LocalAudioTrack);
    watchLivekitMic(lk as unknown as LocalAudioTrack); // LocalTrackPublished firing again
    expect(debug).toHaveBeenCalledTimes(1);
    expect(lk.listenerCount(TrackEvent.Restarted)).toBe(1);

    lk.emit(TrackEvent.Restarted);
    expect(debug).toHaveBeenCalledTimes(2);
  });
});
