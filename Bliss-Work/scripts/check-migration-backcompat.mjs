#!/usr/bin/env node
/**
 * Migration backward-compatibility CI lint.
 *
 *   node scripts/check-migration-backcompat.mjs                # CI mode
 *   node scripts/check-migration-backcompat.mjs --files a.sql b.sql   # direct mode
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every service in this repo runs its own SQL migrations at process boot
 * (Python services via run_migrations(), messaging-svc via Store.Migrate in
 * Go — both glob migrations/*.sql and apply new files in filename order).
 * Prod runs six HTTP services at 2 replicas behind Caddy, and `make
 * prod-deploy` does a health-gated IN-PLACE restart — so during every
 * rollout, old code and new code run concurrently against the POST-migration
 * schema for a real window. A migration that does DROP COLUMN, DROP TABLE, RENAME COLUMN/TABLE,
 * or narrows a column's type breaks the old replica the instant it lands,
 * before the new code that stops needing the old shape is even fully rolled
 * out. Today that's caught only by a human writing "this is additive" in a
 * deploy note. This makes it a CI gate instead.
 *
 * ── What it checks ───────────────────────────────────────────────────────────
 * In CI mode: diffs the PR against its base ref, finds every migration file
 * that is NEWLY ADDED (not modified — an existing applied migration cannot be
 * edited anyway, per check-migrations.mjs's header), and scans each one for a
 * small set of risky patterns. A file that trips one is BLOCKING unless it (or
 * its content) carries an explicit acknowledgment:
 *
 *   -- ACKNOWLEDGE-BREAKING: <reason>
 *
 * anywhere in the file. Same house style as scripts/audit-gate.mjs's advisory
 * allowlist: flag it, allow an explicit documented override, never silently
 * pass. Unlike audit-gate.mjs's centralized ALLOW array, the override lives
 * IN the migration file itself — it sits next to the statement it excuses, so
 * a reviewer sees the DROP and its justification in the same diff hunk, and no
 * separate list has to be kept in sync with every service's migrations/.
 *
 * ── The heuristic, and its limits ────────────────────────────────────────────
 * This is NOT a SQL parser. It strips `--` and block comments (so prose that
 * merely MENTIONS "DROP TABLE" in a header comment, which real migrations in
 * this repo do — see telemetry-svc/migrations/0001_init.sql and
 * messaging-svc/migrations/0019_restore_forward_link.sql — does not trip it),
 * then regex-scans the statements for:
 *
 *   - DROP TABLE / DROP COLUMN            — always breaking for old code.
 *   - RENAME COLUMN / RENAME TO           — same: old code's queries 404.
 *   - ALTER COLUMN ... TYPE <narrower>    — a widening ALTER COLUMN ... TYPE
 *     (e.g. integer -> bigint, varchar(20) -> text) is safe; a narrowing one
 *     truncates or rejects data old code still writes. Telling the two apart
 *     in general needs the column's CURRENT type, which isn't available
 *     without replaying every prior migration. The heuristic instead trusts an
 *     explicit allowlist of unbounded/widening TARGET types (bigint, text,
 *     timestamptz, jsonb, uuid, boolean, unbounded numeric/varchar, ...) and
 *     flags everything else — which means every bounded target (varchar(N),
 *     numeric(p,s)) and every un-listed bare type name (smallint, integer,
 *     real) is flagged, INCLUDING some genuinely-widening changes (e.g.
 *     smallint -> integer). That false-positive is deliberate: a same-file
 *     widening ALTER COLUMN costs one acknowledgment comment to pass, while a
 *     missed narrowing one breaks a live rolling deploy. See CODING_PRACTICES
 *     "a reasonable heuristic is fine here, this doesn't need to be a full SQL
 *     parser."
 *
 * NOT flagged, on purpose: DROP CONSTRAINT/INDEX/POLICY/FUNCTION/TRIGGER (old
 * code doesn't reference these by a name it depends on the same way), ADD
 * COLUMN, ALTER COLUMN ... DROP NOT NULL / SET DEFAULT (both relax, never
 * break, old code).
 *
 * ── Testing ───────────────────────────────────────────────────────────────────
 * `--files` scans exact paths directly, skipping the git diff — this is how
 * this script was checked against a deliberately-risky fixture (write one,
 * run `--files` on it, confirm it fails, delete it) and against the FULL real
 * services/*\/migrations/*.sql corpus (confirm 0 unacknowledged findings; any
 * real DROP/RENAME migration that already merged is a correct match, not a
 * false positive — it just isn't "new" from CI's diff-based point of view).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Both migration-directory layouts in use across services (see check-migrations.mjs). */
const MIGRATION_PATH = /^services\/[^/]+\/(?:migrations|internal\/db\/migrations)\/[^/]+\.sql$/;

const ACK_RE = /--\s*ACKNOWLEDGE-BREAKING:\s*(\S.*\S|\S)/i;

const RISKY_PATTERNS = [
  { name: "DROP TABLE", re: /\bDROP\s+TABLE\b/gi },
  { name: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/gi },
  { name: "RENAME COLUMN/TABLE", re: /\bRENAME\s+(?:COLUMN|TO|TABLE)\b/gi },
];

/** Bare TYPE targets that are always widening/safe, however the column started. */
const SAFE_BARE_TYPES = new Set([
  "bigint",
  "int8",
  "text",
  "boolean",
  "bool",
  "uuid",
  "jsonb",
  "json",
  "double precision",
  "float8",
  "bytea",
  "timestamptz",
  "timestamp with time zone",
  "timestamp without time zone",
  "timestamp",
  "date",
  "interval",
]);
/** Bare (unbounded — no length/precision) targets are also safe; parenthesized forms are not. */
const UNBOUNDED_SAFE_BARE = new Set(["numeric", "decimal", "varchar", "character varying"]);

function isRiskyTypeTarget(typeExpr) {
  const hasParens = typeExpr.includes("(");
  const bare = typeExpr
    .replace(/\(.*$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (SAFE_BARE_TYPES.has(bare)) return false;
  if (!hasParens && UNBOUNDED_SAFE_BARE.has(bare)) return false;
  return true;
}

/**
 * Blank out `--` and `/* *\/` comments IN PLACE (replace with spaces of the
 * same length) so absolute offsets — and therefore line numbers — stay valid
 * against the original text.
 */
function stripSqlComments(sql) {
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/--.*$/gm, (m) => " ".repeat(m.length));
  return out;
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function scanSimplePatterns(stripped) {
  const findings = [];
  for (const { name, re } of RISKY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(stripped))) {
      findings.push({ pattern: name, line: lineAt(stripped, m.index), snippet: m[0].trim() });
    }
  }
  return findings;
}

/** Heuristic, statement-scoped (split on `;`) so TYPE is only correlated with
 *  the ALTER COLUMN in the SAME statement, not the whole file. */
function scanTypeNarrowing(stripped) {
  const findings = [];
  let offset = 0;
  for (const stmt of stripped.split(";")) {
    const stmtStart = offset;
    offset += stmt.length + 1; // +1 for the ';' the split consumed
    if (!/\bALTER\s+COLUMN\b/i.test(stmt)) continue;
    const m = stmt.match(
      /\bTYPE\s+([A-Za-z_][A-Za-z0-9_ ]*?)\s*(\([^)]*\))?\s*(?=$|\bUSING\b|\bCOLLATE\b)/i,
    );
    if (!m) continue;
    const typeExpr = (m[1] + (m[2] ?? "")).trim();
    if (!isRiskyTypeTarget(typeExpr)) continue;
    findings.push({
      pattern: "ALTER COLUMN ... TYPE (narrowing/unrecognized target)",
      line: lineAt(stripped, stmtStart + m.index),
      snippet: `TYPE ${typeExpr}`,
    });
  }
  return findings;
}

function scanFile(absPath) {
  const raw = readFileSync(absPath, "utf8");
  const ack = raw.match(ACK_RE);
  const stripped = stripSqlComments(raw);
  const findings = [...scanSimplePatterns(stripped), ...scanTypeNarrowing(stripped)];
  return { findings, acknowledgedReason: ack ? ack[1].trim() : null };
}

/** Newly-ADDED (not modified) migration files between baseRef and HEAD. */
function listNewMigrationFiles(baseRef) {
  let toplevel;
  let out;
  try {
    // `git diff --name-only` reports paths relative to the git TOPLEVEL, not
    // to this script's ROOT. Those are normally the same directory, but don't
    // assume it — resolve through the toplevel so this is correct even when
    // ROOT is checked out as a subdirectory of a larger repo.
    toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    out = execFileSync(
      "git",
      ["diff", "--diff-filter=A", "--name-only", `${baseRef}...HEAD`],
      { cwd: ROOT, encoding: "utf8" },
    );
  } catch (e) {
    console.error(`check-migration-backcompat: \`git diff\` against ${baseRef} failed:\n`);
    console.error(e.stderr || e.message);
    console.error(
      "\nThis needs enough history to diff against the PR's base ref — the workflow " +
        "checkout must use fetch-depth: 0 (or fetch the base ref explicitly). If running " +
        "locally, pass a ref that exists, e.g.:\n" +
        "  BASE_REF=origin/main node scripts/check-migration-backcompat.mjs",
    );
    process.exit(1);
  }
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => relative(ROOT, join(toplevel, f)).split("\\").join("/"))
    .filter((f) => MIGRATION_PATH.test(f));
}

function report(files) {
  let blocking = 0;
  let waived = 0;

  for (const relPath of files) {
    const absPath = join(ROOT, relPath);
    if (!existsSync(absPath)) continue; // added then deleted later in the same PR
    const { findings, acknowledgedReason } = scanFile(absPath);
    if (findings.length === 0) {
      console.log(`  ok      ${relPath}`);
      continue;
    }
    if (acknowledgedReason) {
      waived++;
      console.log(`  ~ waived  ${relPath} — ${findings.length} finding(s), acknowledged:`);
      console.log(`            "${acknowledgedReason}"`);
      for (const f of findings) console.log(`            line ${f.line}: ${f.pattern} (${f.snippet})`);
      continue;
    }
    blocking++;
    console.error(`  ✗ BLOCKING  ${relPath}`);
    for (const f of findings) {
      console.error(`      line ${f.line}: ${f.pattern}`);
      console.error(`        ${f.snippet}`);
    }
  }

  console.log();
  if (blocking === 0) {
    console.log(
      `check-migration-backcompat: OK — ${files.length} new migration file(s), ` +
        `${waived} waived, 0 blocking`,
    );
    return 0;
  }

  console.error(
    `check-migration-backcompat: ${blocking} new migration file(s) contain a pattern that ` +
      "breaks old code still running against the new schema during a rolling deploy " +
      "(services run 2 replicas behind Caddy; old and new code run concurrently against " +
      "the post-migration schema for a real window).\n",
  );
  console.error(
    "Fix it by making the change additive (add-then-backfill-then-drop-in-a-LATER-release\n" +
      "is the standard pattern — see e.g. task-svc/migrations/003_column_encryption.sql +\n" +
      "005_drop_plaintext_task_cols.sql for how this repo already does that split), or, if the\n" +
      "breaking change is genuinely safe right now (e.g. the column has never been written,\n" +
      "as in integrations-svc/migrations/0007_drop_webhook_payload.sql), add a line anywhere\n" +
      "in the migration file:\n\n" +
      "  -- ACKNOWLEDGE-BREAKING: <why old code hitting the new schema is safe here>\n",
  );
  return 1;
}

function main() {
  const argv = process.argv.slice(2);
  const filesFlagIdx = argv.indexOf("--files");

  let files;
  if (filesFlagIdx !== -1) {
    // Direct mode: scan exact paths, no git diff. Used for testing (a throwaway
    // risky fixture, or the full real corpus) and for a developer checking a
    // migration locally before opening a PR.
    files = argv
      .slice(filesFlagIdx + 1)
      .map((f) => relative(ROOT, resolve(process.cwd(), f)).split("\\").join("/"));
  } else {
    const baseRef =
      process.env.BASE_REF ||
      (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main");
    files = listNewMigrationFiles(baseRef);
    if (files.length === 0) {
      console.log("check-migration-backcompat: no new migration files in this diff — OK");
      process.exit(0);
    }
  }

  process.exit(report(files));
}

main();
