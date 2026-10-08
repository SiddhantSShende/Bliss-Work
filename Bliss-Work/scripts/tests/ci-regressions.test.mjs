import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { expiredAllowlistEntries } from "../audit-gate-policy.mjs";

const scripts = resolve(import.meta.dirname, "..");
const repoRoot = resolve(scripts, "..");

test("restore-test lists media archive entries without extracting to a host temp directory", () => {
  const source = readFileSync(join(scripts, "restore-test.sh"), "utf8");
  assert.match(source, /tar -tf - \| awk 'END \{ print NR \}'/);
  assert.doesNotMatch(source, /tar -xf -/);
  assert.doesNotMatch(source, /TMPDIR_MEDIA/);

  const root = mkdtempSync(join(tmpdir(), "restore-media-list-"));
  try {
    mkdirSync(join(root, "blobs"));
    writeFileSync(join(root, "blobs", "one"), "one");
    writeFileSync(join(root, "blobs", "two"), "two");
    execFileSync("tar", ["-cf", join(root, "media.tar"), "-C", join(root, "blobs"), "one", "two"]);
    const listed = execFileSync("tar", ["-tf", join(root, "media.tar")], { encoding: "utf8" }).trim().split("\n");
    assert.equal(listed.length, 2);
    assert.deepEqual(readdirSync(join(root, "blobs")).sort(), ["one", "two"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeDesktopPublishFixture(root) {
  const source = join(root, "source");
  const dest = join(root, "downloads");
  const backup = join(root, "backups");
  mkdirSync(source);
  mkdirSync(dest);
  const appImage = Buffer.alloc(5 * 1024 * 1024, 0x41);
  appImage.set([0x7f, 0x45, 0x4c, 0x46]);
  writeFileSync(join(source, "BlissWork-linux.AppImage"), appImage);
  writeFileSync(join(source, "latest-linux.yml"), "version: 1.2.4\n");
  writeFileSync(join(dest, "BlissWork-linux.AppImage"), "old-live-installer");
  writeFileSync(join(dest, "latest-linux.yml"), "version: 1.2.3\n");
  return { source, dest, backup };
}

test("desktop publish replaces artifacts atomically, requires a backup, and prunes to retention", (t) => {
  const root = mkdtempSync(join(tmpdir(), "desktop-publish-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { source, dest, backup } = makeDesktopPublishFixture(root);
  for (const stamp of ["20260101T000000Z-1", "20260102T000000Z-2", "20260103T000000Z-3"]) {
    mkdirSync(join(backup, stamp), { recursive: true });
    writeFileSync(join(backup, stamp, "old"), stamp);
  }
  const env = { ...process.env, DEST: dest, BACKUP: backup, BACKUP_RETENTION: "2" };
  const run = spawnSync("bash", [join(scripts, "publish-desktop.sh"), source], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(join(dest, "latest-linux.yml"), "utf8"), "version: 1.2.4\n");
  const liveAppImage = readFileSync(join(dest, "BlissWork-linux.AppImage"));
  assert.equal(liveAppImage.length, 5 * 1024 * 1024);
  assert.deepEqual([...liveAppImage.subarray(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
  assert.equal((statSync(join(dest, "BlissWork-linux.AppImage")).mode & 0o777), 0o644);
  assert.deepEqual(readdirSync(backup).sort().length, 2);
  assert.equal(readdirSync(dest).some((name) => name.includes(".tmp.")), false);

  const blocked = join(root, "backup-is-a-file");
  writeFileSync(blocked, "not a directory");
  writeFileSync(join(dest, "latest-linux.yml"), "version: 1.2.4\n");
  const failedBackup = spawnSync("bash", [join(scripts, "publish-desktop.sh"), source], {
    encoding: "utf8",
    env: { ...env, BACKUP: blocked },
  });
  assert.notEqual(failedBackup.status, 0);
  assert.equal(readFileSync(join(dest, "latest-linux.yml"), "utf8"), "version: 1.2.4\n");
});

test("audit gate rejects expired and malformed waiver review dates", () => {
  const today = "2026-10-08";
  const entries = [
    { id: "expired", reviewBy: "2026-10-01" },
    { id: "current", reviewBy: "2026-10-08" },
    { id: "future", reviewBy: "2026-10-09" },
    { id: "invalid", reviewBy: "2026-02-31" },
  ];
  assert.deepEqual(expiredAllowlistEntries(entries, today).map(({ id }) => id), ["expired", "invalid"]);
  const gate = readFileSync(join(scripts, "audit-gate.mjs"), "utf8");
  assert.match(gate, /expiredAllowlistEntries\(ALLOW\)/);
});

test("manifest publisher's no-op path cleans its temporary clone and uses configured git identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "manifest-publisher-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRepo = join(root, "source-repo");
  const bareRepo = join(root, "manifest.git");
  const input = join(root, "input");
  const temp = join(root, "script-tmp");
  mkdirSync(sourceRepo);
  mkdirSync(input);
  mkdirSync(temp);
  execFileSync("git", ["init", "-b", "main"], { cwd: sourceRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test Publisher"], { cwd: sourceRepo });
  execFileSync("git", ["config", "user.email", "publisher@example.test"], { cwd: sourceRepo });
  writeFileSync(join(sourceRepo, "manifest.json"), JSON.stringify({ version: "1.2.3", files: { "BlissWork.exe": "abc123" } }, null, 2) + "\n");
  execFileSync("git", ["add", "manifest.json"], { cwd: sourceRepo });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: sourceRepo, stdio: "ignore" });
  execFileSync("git", ["clone", "--bare", sourceRepo, bareRepo], { stdio: "ignore" });
  writeFileSync(join(input, "latest.yml"), "version: 1.2.3\nfiles:\n  - url: BlissWork.exe\n    sha512: abc123\n");

  const run = spawnSync("node", [join(scripts, "publish-second-source-manifest.mjs"), input], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: temp, MANIFEST_REPO_GIT_URL: bareRepo },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readdirSync(temp), []);

  const publisher = readFileSync(join(scripts, "publish-second-source-manifest.mjs"), "utf8");
  const protectedTry = publisher.slice(
    publisher.indexOf("\ntry {", publisher.indexOf("const cleanupOnExit")),
    publisher.indexOf("\n} finally {", publisher.indexOf("const cleanupOnExit")),
  );
  assert.doesNotMatch(protectedTry, /process\.exit\s*\(/);
  assert.doesNotMatch(publisher, /noreply@anthropic\.com/);
  assert.match(publisher, /"commit", "-m"/);
});

test("rollback refuses a mismatched or dirty source and does not report completion when web source may not match", () => {
  const makefile = readFileSync(join(repoRoot, "Makefile"), "utf8");
  const rollback = makefile.slice(makefile.indexOf("deploy_rollback() {"), makefile.indexOf("# Keep the N most recent SHA tags"));
  assert.match(rollback, /git rev-parse "\$\$prev_tag\^\{commit\}"/);
  assert.match(rollback, /git status --porcelain/);
  assert.match(rollback, /web_source_matches=0/);
  assert.match(rollback, /Rollback incomplete: skipped web bundle rebuild/);
  assert.match(rollback, /\[ "\$\$PULL_MODE" != "1" \]/);
});

test("S3 migration keeps credentials out of docker argv and rejects mutable image tags", () => {
  const source = readFileSync(join(scripts, "migrate-blobs-to-s3.sh"), "utf8");
  assert.match(source, /export MC_HOST_tb=/);
  assert.match(source, /-e MC_HOST_tb/);
  assert.match(source, /MC_IMAGE must be an immutable/);
  assert.doesNotMatch(source, /minio\/mc:latest/);
  assert.doesNotMatch(source, /alias set tb.*MEDIA_S3_(ACCESS|SECRET)_KEY/);

  const run = spawnSync("bash", [join(scripts, "migrate-blobs-to-s3.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEDIA_S3_ENDPOINT: "object.example.test:9000",
      MEDIA_S3_BUCKET: "media",
      MEDIA_S3_ACCESS_KEY: "access",
      MEDIA_S3_SECRET_KEY: "secret",
      MC_IMAGE: "minio/mc:latest",
    },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /MC_IMAGE must be an immutable/);
});

test("Jenkins requires HTTPS and completes a credential-free TLS preflight before registry login", () => {
  const jenkinsfile = readFileSync(join(repoRoot, "Jenkinsfile"), "utf8");
  assert.match(jenkinsfile, /REGISTRY_SCHEME\s*=\s*'https'/);
  const tlsCheck = jenkinsfile.indexOf('https://${REGISTRY}/v2/');
  const login = jenkinsfile.indexOf('docker login "${REGISTRY}"');
  assert.ok(tlsCheck >= 0 && login > tlsCheck);
});
