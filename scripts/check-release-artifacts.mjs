#!/usr/bin/env node
/**
 * Validate what a release is about to publish, by inspecting the ARTIFACTS.
 *
 * WHY THIS EXISTS. The 0.1.0 installer shipped with
 *   provider: github, owner: SiddhantSShende, repo: Bliss-Work
 * baked into resources/app-update.yml. That repo is private, so electron-updater
 * got a 401/404 on every check, updater.ts logged it and moved on, and every
 * user who installed that build was frozen forever with no signal on screen.
 * The static config in package.json was *already* correct by then — only the
 * emitted artifact was wrong, so a package.json check alone would not have
 * caught it. This inspects what actually goes in the box.
 *
 * Also checks that installers are real files rather than truncated downloads or
 * HTML error pages: /downloads once held 128-byte .dmg "placeholders" that a
 * size-only floor would have to be set absurdly high to catch, and that a
 * magic-byte check rejects instantly.
 *
 * Usage:
 *   node scripts/check-release-artifacts.mjs [releaseDir]
 * Defaults to apps/desktop/release. Skips checks whose inputs are absent (a
 * single-platform CI leg only produces its own artifacts) but FAILS if it finds
 * nothing at all to check — silence must not read as success.
 */
import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = process.argv[2] ? process.argv[2] : join(root, "apps/desktop/release");

const problems = [];
let checked = 0;

// ── 1. The update feed baked into each unpacked app ──────────────────────────
// The bug that started all of this. Must be the generic VPS feed; `github` on a
// private repo is unreadable and fails silently at runtime.
const EXPECTED_PROVIDER = "generic";
const EXPECTED_URL = "https://communication.rnrtechs.com/downloads";

function checkUpdateYml(path, label) {
  checked++;
  const yml = readFileSync(path, "utf8");
  const provider = /^provider:\s*(\S+)/m.exec(yml)?.[1];
  const url = /^url:\s*(\S+)/m.exec(yml)?.[1];
  if (provider !== EXPECTED_PROVIDER) {
    problems.push(
      `${label}: app-update.yml has provider "${provider}", expected "${EXPECTED_PROVIDER}". ` +
        `A github provider on a PRIVATE repo cannot be read by electron-updater — ` +
        `every install built this way can never update itself again.`,
    );
  }
  if (provider === EXPECTED_PROVIDER && url !== EXPECTED_URL) {
    problems.push(`${label}: app-update.yml url is "${url}", expected "${EXPECTED_URL}"`);
  }
}

if (existsSync(releaseDir)) {
  for (const entry of readdirSync(releaseDir)) {
    for (const rel of [
      join(entry, "resources/app-update.yml"), // win-unpacked / linux-unpacked
      join(entry, "BlissWork.app/Contents/Resources/app-update.yml"), // mac
    ]) {
      const p = join(releaseDir, rel);
      if (existsSync(p)) checkUpdateYml(p, entry);
    }
  }
}

// ── 2. Installers are real binaries, not stubs or error pages ────────────────
// Size floor AND magic bytes: a 6 MB HTML error page passes a size check, and a
// 128-byte "dmg" passes nothing but was published anyway.
const MIN_BYTES = 5 * 1024 * 1024;
const MAGIC = {
  ".exe": [Buffer.from("MZ"), "PE executable"],
  ".deb": [Buffer.from("!<arch>"), "ar archive"],
  ".AppImage": [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "ELF binary"],
  ".zip": [Buffer.from([0x50, 0x4b, 0x03, 0x04]), "zip archive"],
};

function head(path, n) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

if (existsSync(releaseDir)) {
  for (const f of readdirSync(releaseDir)) {
    const ext = Object.keys(MAGIC).find((e) => f.endsWith(e));
    const isDmg = f.endsWith(".dmg");
    if (!ext && !isDmg) continue;
    const p = join(releaseDir, f);
    if (!statSync(p).isFile()) continue;
    checked++;

    const size = statSync(p).size;
    if (size < MIN_BYTES) {
      problems.push(
        `${f}: ${size} bytes — below the ${MIN_BYTES} floor. This is a stub or a ` +
          `truncated build, not an installer.`,
      );
      continue;
    }
    if (ext) {
      const [magic, desc] = MAGIC[ext];
      if (!head(p, magic.length).equals(magic)) {
        problems.push(`${f}: does not start with the ${desc} magic bytes — wrong or corrupt file`);
      }
    }
    // .dmg: the koly trailer lives at the END of the file, so size + extension
    // is as far as a cheap check goes here. The size floor already rejects the
    // 128-byte placeholders that shipped before.
  }
}

// ── 3. The Windows exe carries OUR icon, not Electron's ──────────────────────
// A build that skipped rcedit (no wine when cross-building on Linux) still
// succeeds and produces a working installer — it just wears the pale-blue
// Electron atom. Verify the artifact, never the build log.
const ICON_SRC = join(root, "apps/desktop/build/icon.ico");
if (existsSync(releaseDir) && existsSync(ICON_SRC)) {
  const unpacked = join(releaseDir, "win-unpacked/BlissWork.exe");
  if (existsSync(unpacked)) {
    checked++;
    // The 256px PNG-compressed icon is embedded verbatim as an RT_ICON resource,
    // so a substring search over the exe is a reliable, dependency-free check.
    // (icoutils gives a prettier answer but isn't installed on CI runners.)
    const ico = readFileSync(ICON_SRC);
    // Largest entry in the .ico directory = the one worth searching for.
    const count = ico.readUInt16LE(4);
    let best = null;
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16;
      const bytes = ico.readUInt32LE(off + 8);
      const dataOff = ico.readUInt32LE(off + 12);
      if (!best || bytes > best.bytes) best = { bytes, dataOff };
    }
    if (best) {
      const needle = ico.subarray(best.dataOff, best.dataOff + Math.min(best.bytes, 4096));
      if (!readFileSync(unpacked).includes(needle)) {
        problems.push(
          `win-unpacked/BlissWork.exe does not contain build/icon.ico — the resource-edit ` +
            `step (rcedit) did not run, so the app ships the stock Electron icon. ` +
            `Cross-building Windows on Linux needs wine for this.`,
        );
      }
    }
  }
}

if (checked === 0) {
  console.error(
    `check-release-artifacts: found nothing to check under ${releaseDir}.\n` +
      `Refusing to pass — an empty run must not look like a green one.`,
  );
  process.exit(1);
}

if (problems.length) {
  console.error("\nRelease artifact checks FAILED:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}

console.log(`✓ ${checked} release artifact check(s) passed`);
