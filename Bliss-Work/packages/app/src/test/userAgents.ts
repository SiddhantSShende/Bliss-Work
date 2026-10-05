const CHROME = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Real user-agent shapes, one per platform the login policy distinguishes. */
export const UA = {
  macBrowser: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`,
  // Electron's renderer is Chromium: same UA plus the app and Electron tokens.
  macElectron: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME} BlissWork/1.0.0 Electron/31.0.0`,
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  windows: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`,
  windowsElectron: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME} BlissWork/1.0.0 Electron/31.0.0`,
  linux: `Mozilla/5.0 (X11; Linux x86_64) ${CHROME}`,
  android: `Mozilla/5.0 (Linux; Android 14; Pixel 8) ${CHROME} Mobile`,
  unknown: "SomethingElse/1.0",
} as const;
