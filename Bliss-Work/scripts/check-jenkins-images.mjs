#!/usr/bin/env node
/**
 * Keep the Jenkinsfile's per-image build list in step with what is actually
 * built and deployed.
 *
 * WHY THIS EXISTS. The Jenkinsfile's `IMAGES` map is hand-maintained, and it
 * drives two things that fail silently when it drifts:
 *
 *   1. WHICH IMAGES EXIST. Registry-mode deploys (`make prod-deploy` with
 *      REGISTRY set) `compose pull` every image the compose files name. An image
 *      the pipeline never builds has no tag in the registry, so the pull fails,
 *      the ERR trap rolls back, and the whole deploy fails (graph-gw was
 *      missing for exactly this reason).
 *
 *   2. WHEN AN IMAGE IS REBUILT. Change detection rebuilds an image only if a
 *      changed file starts with one of its `paths`. Every image that is judged
 *      "unchanged" is re-tagged from the stale `:latest`, so a Dockerfile COPY
 *      source that is missing from `paths` means edits to it ship NOTHING (a fix
 *      to services/shared/resilience never reached auth-svc or task-svc).
 *
 * Checks, all read-only (no docker, no npm, no network):
 *   A. every `image: ${REGISTRY_PREFIX...}/<name>:` in docker-compose.prod.yml /
 *      docker-compose.registry.yml, and every name in the Makefile's
 *      DEPLOY_SHA_IMAGES, is a key of IMAGES;
 *   B. for every image, each COPY/ADD source in its Dockerfile (resolved against
 *      the build context, `--from=` copies excluded) and the Dockerfile itself
 *      is covered by that image's `paths` or by GLOBAL_PATHS, using the same
 *      `file == p || file.startsWith(p)` rule the pipeline uses.
 *
 * `paths` may list MORE than the Dockerfile copies (e.g. a whole `packages/`);
 * only missing coverage is an error.
 *
 * Usage:  node scripts/check-jenkins-images.mjs [path/to/Jenkinsfile]
 * Exits non-zero on any violation.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const jenkinsfile = process.argv[2] ?? "Jenkinsfile";

/** Strip whole-line `//` comments (they contain quotes and ${...}). */
const stripComments = (text) =>
  text
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

const quoted = (text) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

function parseImages(src) {
  const start = src.indexOf("def IMAGES = [");
  if (start < 0) throw new Error("def IMAGES = [ not found in " + jenkinsfile);
  const end = src.indexOf("\n]\n", start);
  const block = stripComments(src.slice(start, end + 2));
  const images = new Map();
  for (const m of block.matchAll(/'([\w.-]+)'\s*:\s*\[([\s\S]*?)\n {4}\]/g)) {
    const body = m[2];
    const context = /context\s*:\s*'([^']*)'/.exec(body)?.[1];
    const dockerfile = /dockerfile\s*:\s*'([^']*)'/.exec(body)?.[1];
    const paths = quoted(/paths\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? "");
    if (!context || !dockerfile) throw new Error(`IMAGES['${m[1]}'] lacks context/dockerfile`);
    images.set(m[1], { context, dockerfile, paths });
  }
  if (images.size === 0) throw new Error("no entries parsed from IMAGES");
  return images;
}

function parseGlobalPaths(src) {
  const m = /def GLOBAL_PATHS\s*=\s*\[([^\]]*)\]/.exec(stripComments(src));
  return m ? quoted(m[1]) : [];
}

/** COPY/ADD sources that come from the build context (not `--from=`). */
function contextSources(dockerfileText) {
  // Join backslash continuations, drop comments.
  const lines = dockerfileText.replace(/\\\r?\n/g, " ").split("\n");
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^(COPY|ADD)\s+(.*)$/i.exec(line);
    if (!m) continue;
    const args = m[2].trim().split(/\s+/);
    const flags = args.filter((a) => a.startsWith("--"));
    if (flags.some((f) => f.startsWith("--from="))) continue;
    const operands = args.filter((a) => !a.startsWith("--"));
    if (operands.length < 2 || operands[0].startsWith("[")) continue; // JSON form unused here
    out.push(...operands.slice(0, -1)); // last operand is the destination
  }
  return out;
}

/** The pipeline's own match rule: file == p || file.startsWith(p). */
const covers = (p, file) => file === p || file.startsWith(p);

const problems = [];
const jf = read(jenkinsfile);
const images = parseImages(jf);
const globals = parseGlobalPaths(jf);

// ── A. every deployed image is built ────────────────────────────────────────
const deployed = new Map(); // image name -> where it is referenced
for (const f of ["docker-compose.prod.yml", "docker-compose.registry.yml"]) {
  if (!existsSync(join(ROOT, f))) continue;
  for (const m of read(f).matchAll(/^\s*image:\s*\$\{REGISTRY_PREFIX[^}]*\}\/([\w.-]+):/gm)) {
    deployed.set(m[1], f);
  }
}
const mk = /^DEPLOY_SHA_IMAGES\s*:?=\s*(.*)$/m.exec(read("Makefile"));
for (const n of (mk?.[1] ?? "").split(/\s+/).filter(Boolean)) deployed.set(n, deployed.get(n) ?? "Makefile DEPLOY_SHA_IMAGES");
for (const [name, where] of deployed) {
  if (!images.has(name)) {
    problems.push(`image '${name}' is deployed (${where}) but is not in ${jenkinsfile} IMAGES, so it is never built or pushed`);
  }
}

// ── B. every Dockerfile COPY source triggers a rebuild ──────────────────────
for (const [name, spec] of images) {
  const dfPath = spec.dockerfile;
  if (!existsSync(join(ROOT, dfPath))) {
    problems.push(`${name}: dockerfile '${dfPath}' does not exist`);
    continue;
  }
  const triggers = [...spec.paths, ...globals];
  const need = new Set([dfPath]);
  for (const src of contextSources(read(dfPath))) {
    // Wildcards: the literal prefix before the first glob character is what must be covered.
    const literal = src.split(/[*?[]/)[0];
    need.add(posix.normalize(posix.join(spec.context, literal)).replace(/^\.\//, ""));
  }
  for (const src of need) {
    // A directory source matters for every file beneath it.
    const abs = join(ROOT, src);
    const probe = existsSync(abs) && statSync(abs).isDirectory() && !src.endsWith("/") ? src + "/" : src;
    if (!triggers.some((p) => covers(p, probe))) {
      problems.push(`${name}: Dockerfile copies '${src}' but no entry in its paths (or GLOBAL_PATHS) covers it`);
    }
  }
}

if (problems.length) {
  console.error(`check-jenkins-images: ${problems.length} problem(s) in ${jenkinsfile}\n`);
  for (const p of problems) console.error("  - " + p);
  console.error("\nFix the IMAGES map (paths / missing image) so change detection and deploys match what the Dockerfiles and compose files use.");
  process.exit(1);
}
console.log(`check-jenkins-images: OK — ${images.size} images, ${deployed.size} deployed names, all Dockerfile COPY sources covered`);
