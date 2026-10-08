/**
 * The recording's draw loop must keep running while the tab is hidden.
 * requestAnimationFrame does not (the browser stops calling it), which froze the
 * recording as soon as the organiser switched tabs; a timer does.
 *
 * The browser pieces (encoder, canvas, audio graph) are stubbed — what is under
 * test is what drives the drawing and that stop() releases it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAW_INTERVAL_MS, startLocalRecording } from "./localRecording";

vi.mock("./download", () => ({ downloadBlob: vi.fn() }));

const fillRect = vi.fn();
let raf: ReturnType<typeof vi.fn>;

class FakeRecorder {
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  ondataavailable?: (e: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: (e: unknown) => void;
  constructor(public stream: unknown) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  fillRect.mockClear();
  raf = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", class {
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [] } };
    }
    resume = async () => {};
    close = async () => {};
  });
  vi.stubGlobal("MediaStream", class {
    constructor(public tracks: unknown[] = []) {}
    getVideoTracks() {
      return this.tracks;
    }
  });
  HTMLCanvasElement.prototype.captureStream = (() => ({ getVideoTracks: () => [] })) as never;
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect,
    fillText: vi.fn(),
    measureText: () => ({ width: 10 }),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
  })) as never;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const start = () =>
  startLocalRecording({
    tiles: [{ name: "Ada Lovelace", video: null, audio: null, letterbox: false }],
    title: "Standup",
    onError: vi.fn(),
  });

describe("local recording draw loop", () => {
  it("draws on a timer, once per encoder frame, without requestAnimationFrame", () => {
    const rec = start();
    expect(fillRect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DRAW_INTERVAL_MS * 10);

    // Each frame fills the background plus the tile and its name plate.
    const frames = fillRect.mock.calls.filter(([x, y, w, h]) => x === 0 && y === 0 && w === 1280 && h === 720);
    expect(frames).toHaveLength(10);
    expect(raf).not.toHaveBeenCalled();
    void rec.stop();
  });

  it("stops drawing once the recording is stopped", async () => {
    const rec = start();
    vi.advanceTimersByTime(DRAW_INTERVAL_MS * 3);
    await rec.stop();
    fillRect.mockClear();

    vi.advanceTimersByTime(DRAW_INTERVAL_MS * 10);
    expect(fillRect).not.toHaveBeenCalled();
  });
});
