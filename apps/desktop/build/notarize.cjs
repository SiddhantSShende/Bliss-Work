/**
 * electron-builder `afterSign` hook — submits the signed macOS .app to Apple's
 * notarization service so Gatekeeper lets it open WITHOUT the "unidentified
 * developer / cannot be opened" block on end-user machines.
 *
 * It is a NO-OP unless the Apple credentials are present in the environment, so
 * Windows/Linux builds and un-notarized local mac builds keep working unchanged:
 *
 *   APPLE_ID                    – your Apple Developer account email
 *   APPLE_APP_SPECIFIC_PASSWORD – an app-specific password (appleid.apple.com)
 *   APPLE_TEAM_ID               – your 10-char Developer Team ID
 *
 * (Alternatively set APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER to
 * notarize with an App Store Connect API key.)
 *
 * Signing itself is handled by electron-builder from CSC_LINK/CSC_KEY_PASSWORD
 * (a Developer ID Application cert). Notarization only runs AFTER a real
 * Developer ID signature exists — an ad-hoc/unsigned build is skipped here.
 */
const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const hasPassword = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
  const hasApiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  if (!hasPassword && !hasApiKey) {
    console.log("[notarize] Apple credentials not set — skipping notarization (build stays ad-hoc/unsigned).");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`[notarize] submitting ${appPath} to Apple — this can take several minutes…`);

  const opts = hasApiKey
    ? {
        appPath,
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      }
    : {
        appPath,
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      };

  await notarize(opts);
  console.log("[notarize] done — Gatekeeper will now accept the app.");
};
