import { useEffect } from 'react';
import { meetingUi } from './meetingUi';
import { pip } from './pip';

/**
 * Keep Android Picture-in-Picture in step with a live call.
 *
 * While `active` (a call is connected) the native side is armed, so leaving the
 * app shrinks the call into the PiP window instead of backgrounding it — the
 * call keeps its microphone and connection. Entering/leaving PiP is mirrored
 * into `meetingUi`, and the UI state is reset when the call is over.
 */
export function usePip(active: boolean, aspect: { w: number; h: number } = { w: 9, h: 16 }): void {
  useEffect(() => {
    if (!active) return;
    pip.setArmed(true, aspect.w, aspect.h);
    return () => pip.setArmed(false, aspect.w, aspect.h);
  }, [active, aspect.w, aspect.h]);

  useEffect(() => pip.onChange((inPip) => meetingUi.setInPip(inPip)), []);

  useEffect(() => {
    if (!active) meetingUi.reset();
  }, [active]);
}
