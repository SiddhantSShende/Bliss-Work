#!/usr/bin/env node
/**
 * Post-install fixes for third-party native modules that no longer build under
 * the Gradle/AGP this app uses. Idempotent, and a no-op when a module is absent
 * (this runs on every workspace `npm install`, including web/desktop CI).
 *
 * - @react-native-cookies/cookies@6.2.1 (latest published, unmaintained):
 *   android/build.gradle calls `jcenter()`, which Gradle 9 removed from
 *   RepositoryHandler — "Could not find method jcenter()" while configuring the
 *   project. jcenter was a read-only mirror of Maven Central, so mavenCentral()
 *   is the drop-in replacement.
 */
const fs = require('node:fs');
const path = require('node:path');

function patchFile(file, transform) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after === before) return false;
  fs.writeFileSync(file, after);
  return true;
}

let cookiesGradle;
try {
  cookiesGradle = path.join(
    path.dirname(require.resolve('@react-native-cookies/cookies/package.json')),
    'android',
    'build.gradle',
  );
} catch {
  process.exit(0); // module not installed
}

if (patchFile(cookiesGradle, (s) => s.replace(/\bjcenter\(\)/g, 'mavenCentral()'))) {
  console.log('[patch-native-deps] @react-native-cookies/cookies: jcenter() -> mavenCentral()');
}
