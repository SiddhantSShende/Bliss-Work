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
