/**
 * Audio capture defaults for calls. Mirrors AUDIO_CAPTURE_DEFAULTS in
 * packages/app/src/lib/mediaConstraints.ts (web/desktop), which @taskboard/app
 * does not export — same three settings so a mobile call sounds like a web one:
 * echo cancellation, noise suppression and automatic gain control.
 */
export const AUDIO_CAPTURE_DEFAULTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;
