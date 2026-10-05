jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Linking: { openSettings: jest.fn() },
  Platform: { OS: 'android' },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: 'android.permission.RECORD_AUDIO', CAMERA: 'android.permission.CAMERA' },
    RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
    requestMultiple: jest.fn(),
  },
}));
import { Alert, Linking, PermissionsAndroid } from 'react-native';
import { deniedMessage, describeDenied, ensureCallPermissions } from '../permissions';

const MIC = 'android.permission.RECORD_AUDIO' as never;
const CAM = 'android.permission.CAMERA' as never;
const req = PermissionsAndroid.requestMultiple as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('describeDenied', () => {
  it('is null when everything was granted', () => {
    expect(describeDenied([MIC, CAM], { [MIC]: 'granted', [CAM]: 'granted' })).toBeNull();
  });
  it('names exactly what is missing', () => {
    expect(describeDenied([MIC, CAM], { [MIC]: 'granted', [CAM]: 'denied' })).toEqual({ what: 'camera', blocked: false });
    expect(describeDenied([MIC, CAM], { [MIC]: 'denied', [CAM]: 'denied' })?.what).toBe('microphone and camera');
    expect(describeDenied([MIC], { [MIC]: 'denied' })?.what).toBe('microphone');
  });
  it('flags a permanent denial', () => {
    expect(describeDenied([MIC, CAM], { [MIC]: 'granted', [CAM]: 'never_ask_again' })?.blocked).toBe(true);
  });
});

describe('deniedMessage', () => {
  it('points at Settings only when Android will not ask again', () => {
    expect(deniedMessage({ what: 'camera', blocked: true }, 'video').body).toMatch(/Settings/);
    expect(deniedMessage({ what: 'camera', blocked: false }, 'video').body).not.toMatch(/Settings/);
  });
});

describe('ensureCallPermissions', () => {
  it('asks for the microphone only on a voice call', async () => {
    req.mockResolvedValue({ [MIC]: 'granted' });
    expect(await ensureCallPermissions('audio')).toBe(true);
    expect(req).toHaveBeenCalledWith([MIC]);
    expect(Alert.alert).not.toHaveBeenCalled();
  });
  it('asks for camera too on video, and a refusal explains itself', async () => {
    req.mockResolvedValue({ [MIC]: 'granted', [CAM]: 'denied' });
    expect(await ensureCallPermissions('video')).toBe(false);
    expect(req).toHaveBeenCalledWith([MIC, CAM]);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });
  it('a permanent denial offers to open Settings, and that button works', async () => {
    req.mockResolvedValue({ [MIC]: 'never_ask_again' });
    expect(await ensureCallPermissions('audio')).toBe(false);
    const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as { text: string; onPress?: () => void }[];
    expect(buttons.map((b) => b.text)).toEqual(['Not now', 'Open Settings']);
    buttons[1]!.onPress!();
    expect(Linking.openSettings).toHaveBeenCalled();
  });
});
