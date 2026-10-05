import { Platform } from 'react-native';
import type { ClientPlatform } from '@taskboard/shared';

/** What /auth/login is told about this app. React Native has no user agent to
 *  read, so this comes from `Platform.OS`; the build only targets iOS and
 *  Android, and anything else is "unknown" (the server then requires a CAPTCHA). */
export const clientPlatform: ClientPlatform =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown';
