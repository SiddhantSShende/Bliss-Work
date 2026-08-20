#!/usr/bin/env node
/**
 * Guard the migration directories against the three ways they duplicate.
 *
 * WHY THIS EXISTS. Migrations are applied in the LEXICAL ORDER of their
 * filenames — `sort.Strings(names)` in messaging-svc's Store.Migrate,
 * `sorted(MIGRATIONS_DIR.glob("*.sql"))` in every Python service's
 * run_migrations. The filename is therefore not a label, it is the schedule,
 * and three separate kinds of duplication had already crept in:
 *
 *   1. Two files claiming the SAME version. messaging-svc has 0014 twice and
 *      0022 twice; task-svc has 003 twice. Their order is then decided by
 *      whatever word follows the number, which nobody writing the second file
 *      is thinking about. None of those pairs happens to have an ordering
 *      dependency — that is luck, not design.
 *
 *   2. The same SQL block pasted into file after file. The org_isolation RLS
 *      policy was copied into seven messaging-svc migrations in five spellings,
 *      and two of the copies dropped `schemaname = current_schema()` from the
 *      pg_policies guard, so their policy can silently never be created.
 *      0026_org_isolation.sql gives that block one definition —
 *      apply_org_isolation(table) — and this check keeps the eighth copy from
 *      being written.
 *
 *   3. A file copied wholesale. Cheap to detect, so it is checked too.
 *
 * None of this can be fixed by renaming or rewriting what has already run: both
 * runners key their schema_migrations ledger on FILENAME + checksum, so a
 * rename re-runs the file under a new name and strands the old one, and an edit
 * never reaches a database that already applied the old text. The existing
 * collisions are therefore grandfathered BY NAME below, and the lists are
 * closed — they exist to make the next one fail, not to be appended to.
 *
 * Cross-SERVICE duplication is deliberately NOT flagged. auth-svc,
 * integrations-svc, task-svc, messaging-svc and notification-svc each carry a
 * near-identical outbox_dead_letter migration, and that is correct: they own
 * separate databases, and sharing migration files across a service boundary
 * would couple five services' schema history together.
 *
 * Usage:  node scripts/check-migrations.mjs
 * Exits non-zero on any violation.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** <version>_<lower_snake_name>.sql — the shape every migration must have. */
const MIGRATION_NAME = /^(\d+)_[a-z0-9_]+\.sql$/;

/**
 * Version numbers that were used twice before this check existed.
 *
 * ⚠️ CLOSED LIST. A new collision belongs nowhere near here — give the file the
 * next free version instead. These two survive only because renaming an applied
 * migration is worse than the collision (see the header).
 */
const GRANDFATHERED_VERSIONS = {
  "services/messaging-svc/migrations": {
    "0014": "0014_forward_link.sql + 0014_message_features.sql",
    "0022": "0022_channel_message_actions.sql + 0022_repair_channel_owners.sql",
  },
  "services/task-svc/migrations": {
    "003": "003_column_encryption.sql + 003_rls.sql",
  },
};

/**
 * The migrations that inline the org_isolation policy block.
 *
 * ⚠️ CLOSED LIST. Each service's *_rls.sql could only cover the tables that
 * existed when it ran, so every migration that added an org-bearing table
 * afterwards brought its own copy — eighteen files across five services, which
 * is exactly how two of messaging-svc's ended up with a weaker guard than the
 * rest. Every service now defines apply_org_isolation() in its own database,
 * and everything from that migration on calls it.
 */
const GRANDFATHERED_INLINE_RLS = new Set([
  "services/auth-svc/migrations/0003_rls.sql",
  "services/auth-svc/migrations/0005_user_tokens_and_hardening.sql",
  "services/integrations-svc/migrations/0002_rls.sql",
  "services/integrations-svc/migrations/0004_mentions.sql",
  "services/integrations-svc/migrations/0005_app_credentials.sql",
  "services/integrations-svc/migrations/0008_connection_verification.sql",
  "services/messaging-svc/migrations/0007_rls.sql",
  "services/messaging-svc/migrations/0008_forwards.sql",
  "services/messaging-svc/migrations/0010_attachments.sql",
  "services/messaging-svc/migrations/0013_channel_blocks.sql",
  "services/messaging-svc/migrations/0014_message_features.sql",
  "services/messaging-svc/migrations/0015_calls.sql",
  "services/messaging-svc/migrations/0019_restore_forward_link.sql",
  "services/messaging-svc/migrations/0023_mail.sql",
  "services/task-svc/migrations/003_rls.sql",
  "services/task-svc/migrations/006_task_availability_hidden.sql",
  "services/telemetry-svc/migrations/0001_init.sql",
  "services/telemetry-svc/migrations/0002_rls.sql",
]);

/** How a service says "I have the helper" — the definition, in any of its files. */
const HELPER_DEFINITION = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+apply_org_isolation/i;

const problems = [];
const fail = (msg) => problems.push(msg);

/** Every migrations/ directory in the repo, wherever a service chose to put it. */
function findMigrationDirs() {
  const found = [];
  const servicesDir = join(ROOT, "services");
  if (!existsSync(servicesDir)) return found;
  for (const svc of readdirSync(servicesDir).sort()) {
    // Both layouts in use: services/<svc>/migrations and, for notification-svc,
    // services/<svc>/internal/db/migrations.
    for (const candidate of ["migrations", join("internal", "db", "migrations")]) {
      const dir = join(servicesDir, svc, candidate);
      if (existsSync(dir) && statSync(dir).isDirectory()) found.push(dir);
    }
  }
  return found;
}

function checkDir(dir) {
  const rel = relative(ROOT, dir).split("\\").join("/");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) return;

  const grandfathered = GRANDFATHERED_VERSIONS[rel] ?? {};
  const byVersion = new Map();
  const byContent = new Map();
  const widths = new Set();

  for (const name of files) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      fail(`${rel}/${name}\n    does not match <version>_<lower_snake_name>.sql`);
      continue;
    }
    const version = match[1];
    widths.add(version.length);
    byVersion.set(version, [...(byVersion.get(version) ?? []), name]);

    const body = readFileSync(join(dir, name));
    const hash = createHash("sha256").update(body).digest("hex");
    byContent.set(hash, [...(byContent.get(hash) ?? []), name]);
  }

  // 1. One version, one file.
  for (const [version, names] of byVersion) {
    if (names.length < 2 || grandfathered[version]) continue;
    fail(
      `${rel}\n    version ${version} is used by ${names.length} files: ${names.join(", ")}\n` +
        `    Migrations run in filename order, so two files sharing a number leave\n` +
        `    their order to the word after it. Renumber the new one.`,
    );
  }
  // A grandfathered entry that stopped being true is a comment that lies.
  for (const [version, note] of Object.entries(grandfathered)) {
    if ((byVersion.get(version) ?? []).length < 2) {
      fail(`${rel}\n    version ${version} is grandfathered (${note}) but is no longer duplicated — drop it`);
    }
  }

  // 2. One padding width, or lexical order stops matching numeric order at the
  //    first rollover: "009" then "10" sorts 10 FIRST.
  if (widths.size > 1) {
    fail(
      `${rel}\n    mixes ${widths.size} version widths (${[...widths].sort().join(", ")} digits).\n` +
        `    Pad every file in a service to the same width or the ordering breaks at 10.`,
    );
  }

  // 3. No file is a byte-for-byte copy of another.
  for (const names of byContent.values()) {
    if (names.length > 1) {
      fail(`${rel}\n    identical file contents: ${names.join(", ")}`);
    }
  }
}

/**
 * The org_isolation block has one definition per database now. Anything that
 * inlines it instead of calling apply_org_isolation() is the next copy.
 *
 * Applied only to services that actually DEFINE the helper — a service without
 * it in its own database cannot call it, and telling somebody to use a function
 * that does not exist there would be worse than the duplication. A service that
 * adopts the helper later is covered automatically, with nothing to wire up.
 */
function checkInlineRls(dir) {
  const rel = relative(ROOT, dir).split("\\").join("/");
  const names = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const bodies = new Map(names.map((n) => [n, readFileSync(join(dir, n), "utf8")]));

  const helper = names.find((n) => HELPER_DEFINITION.test(bodies.get(n)));
  if (!helper) return;

  for (const name of names) {
    const path = `${rel}/${name}`;
    if (name === helper || GRANDFATHERED_INLINE_RLS.has(path)) continue;
    if (/CREATE\s+POLICY\s+org_isolation/i.test(bodies.get(name))) {
      fail(
        `${path}\n    inlines the org_isolation policy block.\n` +
          `    Call SELECT apply_org_isolation('<table>'); instead — one definition,\n` +
          `    in ${rel}/${helper}. Copying it by hand is how two of the earlier\n` +
          `    copies lost their schemaname guard.`,
      );
    }
  }
}

const dirs = findMigrationDirs();
if (dirs.length === 0) {
  console.error("No migrations directories found — is this the repo root?");
  process.exit(1);
}
for (const dir of dirs) {
  checkDir(dir);
  checkInlineRls(dir);
}

// A grandfathered path that no longer exists is a stale exemption: it would
// silently keep excusing a file somebody re-adds under the same name.
for (const path of GRANDFATHERED_INLINE_RLS) {
  if (!existsSync(join(ROOT, path))) {
    fail(`${path}\n    is exempted from the inline-RLS check but no longer exists — drop it`);
  }
}

const dirCount = dirs.length;
if (problems.length > 0) {
  console.error(`\n❌ migration check failed (${problems.length} problem(s) across ${dirCount} directories):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log(
  `✅ migrations OK — ${dirCount} directories: unique versions, one padding width, ` +
    `no byte-identical files, no re-inlined org_isolation block`,
);
