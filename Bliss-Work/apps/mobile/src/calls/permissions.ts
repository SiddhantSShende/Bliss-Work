import { Alert, Linking, PermissionsAndroid, Platform, type Permission } from 'react-native';
import type { CallMedia } from './callController';

/**
 * Microphone (+ camera for video) permission for a call or meeting.
 *
 * Android: asked explicitly here so a refusal is reported BEFORE anyone is
 * rung or a room is entered, instead of surfacing as a getUserMedia failure
 * mid-call. Only these two dangerous permissions are ever requested for
 * calling. iOS: the system prompt appears on first capture (usage strings are
 * in Info.plist), so there is nothing to pre-ask.
 *
 * A refusal always explains itself. If Android will not ask again ("Don't ask
 * again" / denied twice) the only way forward is the system settings, so the
 * message offers to open them.
 */

type Result = Record<string, string>;

export interface DeniedInfo {
  /** What is missing, in words: "microphone", "camera" or "microphone and camera". */
  what: string;
  /** Android will not show the prompt again: only Settings can fix it. */
  blocked: boolean;
}

/** Pure: turn the outcome of a permission request into what to tell the user. */
export function describeDenied(wanted: readonly Permission[], result: Result): DeniedInfo | null {
  const denied = wanted.filter((p) => result[p] !== PermissionsAndroid.RESULTS.GRANTED);
  if (denied.length === 0) return null;
  const mic = denied.includes(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  const cam = denied.includes(PermissionsAndroid.PERMISSIONS.CAMERA);
  return {
    what: mic && cam ? 'microphone and camera' : mic ? 'microphone' : 'camera',
    blocked: denied.some((p) => result[p] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN),
  };
}

/** Pure: the alert text for a denial. */
export function deniedMessage(info: DeniedInfo, media: CallMedia): { title: string; body: string } {
  const use = media === 'video' ? 'video calls and meetings' : 'calls and meetings';
  return info.blocked
    ? {
        title: `Allow ${info.what} access`,
        body: `BlissWork needs your ${info.what} for ${use}, and Android will not ask again. Open Settings → Permissions and turn it on, then try again.`,
      }
    : {
        title: `${info.what[0]!.toUpperCase()}${info.what.slice(1)} access is off`,
        body: `BlissWork needs your ${info.what} for ${use}. Allow it when asked, then try again.`,
      };
}

async function requestOrExplain(wanted: Permission[], media: CallMedia): Promise<boolean> {
  const result = (await PermissionsAndroid.requestMultiple(wanted)) as Result;
  const info = describeDenied(wanted, result);
  if (!info) return true;
  const { title, body } = deniedMessage(info, media);
  Alert.alert(
    title,
    body,
    info.blocked
      ? [{ text: 'Not now', style: 'cancel' }, { text: 'Open Settings', onPress: () => void Linking.openSettings() }]
      : [{ text: 'OK' }],
  );
  return false;
}

export async function ensureCallPermissions(media: CallMedia): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const wanted =
    media === 'video'
      ? [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, PermissionsAndroid.PERMISSIONS.CAMERA]
      : [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  return requestOrExplain(wanted, media);
}

/**
 * Camera permission on its own, for turning the camera on MID-call/meeting.
 * A voice call or an audio meeting only asked for the microphone when it
 * started, so without this the camera button hit a refused getUserMedia and
 * silently did nothing.
 */
export async function ensureCameraPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  return requestOrExplain([PermissionsAndroid.PERMISSIONS.CAMERA], 'video');
}

/** The camera was allowed but could not be started (in use elsewhere, or — on
 *  iOS, where the system prompt only ever appears once — turned off in Settings). */
export function alertCameraUnavailable(): void {
  Alert.alert('Camera unavailable', 'BlissWork could not start your camera. Check that another app is not using it and that camera access is allowed in Settings.', [
    { text: 'OK', style: 'cancel' },
    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
  ]);
}

/** Screen sharing started but the OS/SDK refused it (not the user saying no). */
export function alertScreenShareFailed(reason: string): void {
  Alert.alert('Could not share your screen', reason ? `Android reported: ${reason}` : 'Something went wrong starting the screen capture. Try again.', [{ text: 'OK' }]);
}
