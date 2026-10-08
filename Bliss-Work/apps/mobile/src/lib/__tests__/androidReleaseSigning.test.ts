import * as fs from 'fs';
import * as path from 'path';

/**
 * Static guard for android/app/build.gradle (Gradle itself cannot run in CI /
 * most dev boxes): a release build must never be signed with the public debug
 * keystore, and must fail loudly when no release keystore is configured.
 */
const gradle = fs.readFileSync(path.join(__dirname, '../../../android/app/build.gradle'), 'utf8');

/** Body of `name { ... }` (brace-matched), skipping `//` comments. */
function block(src: string, header: RegExp): string {
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const m = header.exec(code);
  if (!m) throw new Error(`block not found: ${header}`);
  let depth = 0;
  for (let i = code.indexOf('{', m.index); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(m.index, i + 1);
  }
  throw new Error('unbalanced braces');
}

describe('android release signing', () => {
  const buildTypes = block(gradle, /buildTypes\s*\{/);
  const release = block(buildTypes, /release\s*\{/);
  const debug = block(buildTypes, /debug\s*\{/);

  it('keeps debug builds on the debug keystore', () => {
    expect(debug).toMatch(/signingConfig\s+signingConfigs\.debug/);
  });

  it('never signs the release build with the debug keystore', () => {
    expect(release).not.toMatch(/signingConfigs\.debug/);
    expect(release).not.toMatch(/signingConfigs\[['"]debug['"]\]/);
    expect(release).toMatch(/signingConfig\s+signingConfigs\.findByName\('release'\)/);
  });

  it('reads release keystore settings from the environment, not the repo', () => {
    const signingConfigs = block(gradle, /signingConfigs\s*\{/);
    const releaseCfg = block(signingConfigs, /release\s*\{/);
    for (const k of ['STORE_FILE', 'STORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
      expect(releaseCfg).toContain(`releaseSigning('BLISSWORK_UPLOAD_${k}')`);
    }
    expect(releaseCfg).not.toMatch(/(?:storePassword|keyPassword|keyAlias)\s+['"]/);
  });

  it('fails a release build with a GradleException when the keystore is not configured', () => {
    const check = block(gradle, /gradle\.taskGraph\.whenReady\s*\{/);
    expect(check).toMatch(/\(assemble\|bundle\|package\|install\)/);
    expect(check).toContain('throw new GradleException');
    expect(check).toContain('BLISSWORK_UPLOAD_STORE_FILE');
  });
});
