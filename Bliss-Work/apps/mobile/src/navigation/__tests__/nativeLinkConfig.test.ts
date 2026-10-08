import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mobileRoot = resolve(__dirname, '../../../');
const appConfig = JSON.parse(readFileSync(resolve(mobileRoot, 'app.json'), 'utf8')) as {
  expo: { scheme?: string };
};
const infoPlist = readFileSync(resolve(mobileRoot, 'ios/BlissWorkMobile/Info.plist'), 'utf8');
const androidManifest = readFileSync(resolve(mobileRoot, 'android/app/src/main/AndroidManifest.xml'), 'utf8');

describe('native mobile configuration', () => {
  it('registers the blisswork URL scheme in Expo and the iOS app', () => {
    expect(appConfig.expo.scheme).toBe('blisswork');
    expect(infoPlist).toMatch(/<key>CFBundleURLSchemes<\/key>[\s\S]*?<string>blisswork<\/string>/);
  });

  it('disables Android cloud backup for app data', () => {
    expect(androidManifest).toMatch(/<application\b[^>]*android:allowBackup="false"/);
  });
});
