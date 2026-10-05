import { Platform } from 'react-native';
import { AudioSession } from '@livekit/react-native';

/** Output ids differ per platform — see AudioSession.getAudioOutputs. */
const SPEAKER = Platform.OS === 'ios' ? 'force_speaker' : 'speaker';
const EARPIECE = Platform.OS === 'ios' ? 'default' : 'earpiece';

let active = false;

/** Take the audio route for a call (voice-communication mode). Idempotent. */
export async function startCallAudio(): Promise<void> {
  if (active) return;
  active = true;
  try {
    await AudioSession.startAudioSession();
  } catch {
    active = false;
  }
}

/** Give the audio route back. Idempotent. */
export async function stopCallAudio(): Promise<void> {
  if (!active) return;
  active = false;
  try {
    await AudioSession.stopAudioSession();
  } catch {
    /* already stopped */
  }
}

/** Loudspeaker vs earpiece. A no-op until the session has started. */
export function applySpeaker(on: boolean): void {
  void AudioSession.selectAudioOutput(on ? SPEAKER : EARPIECE).catch(() => {});
}
