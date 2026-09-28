/**
 * Shared audio-capture defaults for both call paths — the 1:1 peer connection
 * (callManager.ts's getUserMedia) and the LiveKit room (useCallRoom.ts's
 * Room constructor). Stated rather than left as an implicit browser default,
 * since a default is a thing that changes without telling anyone:
 *
 *   echoCancellation — the difference between a call and an echo chamber.
 *   noiseSuppression — removes steady-state room noise (fans, traffic, hiss).
 *   autoGainControl  — levels a quiet or over-hot mic instead of letting it
 *     hiss at high gain or clip.
 *
 * One shared object rather than two independently-tuned ones, so a future
 * change to this trio cannot silently apply to only one of the two call
 * paths.
 */
export const AUDIO_CAPTURE_DEFAULTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

/**
 * What the lobby's camera PREVIEW asks for: the picture the room will publish.
 *
 * useCallRoom captures at VideoPresets.h720 (1280×720, 16:9). The preview used
 * to ask for a bare `video: true`, which browsers answer with whatever the
 * device's default mode is — very often 640×480, 4:3, and on many cameras a
 * different field of view from their 16:9 mode. The person checking their
 * framing was then looking at a different picture from the one everyone else
 * would get, and the in-call tile appeared "zoomed" against it. `ideal`, not
 * `exact`: a camera that cannot do 720p still opens, at what it can do.
 *
 * Preview only — this stream is never sent anywhere (the room publishes its own).
 */
export const CAMERA_PREVIEW_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
} as const;
