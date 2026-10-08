#!/usr/bin/env node
/**
 * Locale parity check. English (locales/en) is the source of truth; every other
 * locale registered in packages/app/src/i18n/locales.ts must mirror it.
 *
 *   node scripts/check-locales.mjs            # every registered locale
 *   node scripts/check-locales.mjs ja de      # just these
 *   node scripts/check-locales.mjs --warn     # also list strings identical to English
 *
 * Errors (exit 1): missing/extra namespace file, missing/extra key, empty or
 * non-string value, plural categories that do not match the language's CLDR
 * categories, a different set of {{placeholders}}, markup tags, or URLs than the
 * English source, and registry/directory mismatch. Zero dependencies — the
 * catalogs are plain JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i18nDir = path.join(root, "packages/app/src/i18n");
const localesDir = path.join(i18nDir, "locales");

const args = process.argv.slice(2);
const warnIdentical = args.includes("--warn");
const only = args.filter((a) => !a.startsWith("--"));

const registrySrc = fs.readFileSync(path.join(i18nDir, "locales.ts"), "utf8");
const registry = [...registrySrc.matchAll(/\bcode:\s*"([A-Za-z-]+)"/g)].map((m) => m[1]);

const errors = [];
const warnings = [];
const err = (loc, where, msg) => errors.push(`${loc} ${where}: ${msg}`);

// ── registry ↔ directories ───────────────────────────────────────────────────
const dirs = fs.readdirSync(localesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
// With explicit locale arguments only those are held to "must exist"; the full run checks all.
for (const code of registry) if (!dirs.includes(code) && (only.length === 0 || only.includes(code))) err(code, "registry", `locales/${code}/ does not exist`);
for (const d of dirs) if (!registry.includes(d)) err(d, "registry", `locales/${d}/ exists but is not in i18n/locales.ts`);
if (!registry.includes("en")) err("en", "registry", "English must be registered");

// ── helpers ──────────────────────────────────────────────────────────────────
const PLURAL = ["zero", "one", "two", "few", "many", "other"];
const pluralRe = new RegExp(`^(.*)_(${PLURAL.join("|")})$`);

function readNs(locale, file) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, locale, file), "utf8"));
}

/** Flatten to { "a.b.c": value }. Non-string leaves are reported by the caller. */
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

/** Group plural variants: { base → { category → value } }, plus plain keys. */
function group(flat) {
  const plain = {};
  const plurals = {};
  for (const [key, value] of Object.entries(flat)) {
    const m = pluralRe.exec(key);
    if (m) (plurals[m[1]] ??= {})[m[2]] = value;
    else plain[key] = value;
  }
  return { plain, plurals };
}

const placeholders = (s) => new Set([...String(s).matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]));
const tags = (s) => [...String(s).matchAll(/<\/?[A-Za-z][A-Za-z0-9]*\s*\/?>|<\/?\d+>/g)].map((m) => m[0].replace(/\s+/g, "")).sort();
const urls = (s) => [...String(s).matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]).sort();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function checkValue(loc, where, en, value, { subsetPlaceholders = false, enUnion } = {}) {
  if (typeof value !== "string") return err(loc, where, "value is not a string");
  if (value.trim() === "") return err(loc, where, "empty value");
  const open = (value.match(/\{\{/g) ?? []).length;
  const close = (value.match(/\}\}/g) ?? []).length;
  if (open !== close) err(loc, where, "unbalanced {{ }}");
  const want = enUnion ?? placeholders(en);
  const got = placeholders(value);
  const bad = subsetPlaceholders ? [...got].some((p) => !want.has(p)) : !setEq(got, want);
  if (bad) err(loc, where, `placeholders {${[...got]}} do not match English {${[...want]}}`);
  if (!same(tags(value), tags(en))) err(loc, where, `markup tags [${tags(value)}] do not match English [${tags(en)}]`);
  if (!same(urls(value), urls(en))) err(loc, where, `URLs [${urls(value)}] do not match English [${urls(en)}]`);
}

// ── English structure ────────────────────────────────────────────────────────
const enFiles = fs.readdirSync(path.join(localesDir, "en")).filter((f) => f.endsWith(".json")).sort();
const enData = {};
for (const f of enFiles) {
  const flat = flatten(readNs("en", f));
  for (const [k, v] of Object.entries(flat)) {
    if (typeof v !== "string" || v.trim() === "") err("en", `${f}:${k}`, "English value must be a non-empty string");
  }
  enData[f] = group(flat);
}

// ── every other locale ───────────────────────────────────────────────────────
const targets = registry.filter((c) => c !== "en" && (only.length === 0 || only.includes(c)));

for (const loc of targets) {
  if (!dirs.includes(loc)) continue;
  const required = new Intl.PluralRules(loc).resolvedOptions().pluralCategories;
  const files = fs.readdirSync(path.join(localesDir, loc)).filter((f) => f.endsWith(".json")).sort();
  for (const f of enFiles) if (!files.includes(f)) err(loc, f, "namespace file is missing");
  for (const f of files) if (!enFiles.includes(f)) err(loc, f, "namespace file has no English counterpart");

  for (const f of enFiles) {
    if (!files.includes(f)) continue;
    let flat;
    try {
      flat = flatten(readNs(loc, f));
    } catch (e) {
      err(loc, f, `invalid JSON: ${e.message}`);
      continue;
    }
    const mine = group(flat);
    const en = enData[f];

    for (const key of Object.keys(en.plain)) {
      if (!(key in mine.plain)) err(loc, `${f}:${key}`, "key is missing");
      else {
        checkValue(loc, `${f}:${key}`, en.plain[key], mine.plain[key]);
        if (warnIdentical && mine.plain[key] === en.plain[key] && en.plain[key].length > 12) {
          warnings.push(`${loc} ${f}:${key}: identical to English`);
        }
      }
    }
    for (const key of Object.keys(mine.plain)) if (!(key in en.plain)) err(loc, `${f}:${key}`, "extra key (not in English)");

    for (const base of Object.keys(en.plurals)) {
      const forms = mine.plurals[base];
      if (!forms) {
        err(loc, `${f}:${base}_*`, `plural group is missing (needs ${required.join(", ")})`);
        continue;
      }
      for (const cat of required) if (!(cat in forms)) err(loc, `${f}:${base}_${cat}`, "plural form is missing");
      for (const cat of Object.keys(forms)) if (!required.includes(cat)) err(loc, `${f}:${base}_${cat}`, `${loc} does not use the "${cat}" plural category`);
      const enForms = en.plurals[base];
      const union = new Set(Object.values(enForms).flatMap((v) => [...placeholders(v)]));
      for (const [cat, value] of Object.entries(forms)) {
        const reference = enForms[cat] ?? enForms.other ?? Object.values(enForms)[0];
        checkValue(loc, `${f}:${base}_${cat}`, reference, value, { subsetPlaceholders: cat !== "other", enUnion: cat === "other" ? placeholders(enForms.other ?? reference) : union });
      }
    }
    for (const base of Object.keys(mine.plurals)) if (!(base in en.plurals)) err(loc, `${f}:${base}_*`, "extra plural group (not in English)");
  }
}

// ── release gate (informational) ─────────────────────────────────────────────
const gated = [...registrySrc.matchAll(/\bcode:\s*"([A-Za-z-]+)"[^}]*?\bready:\s*(true|false)/g)]
  .filter((m) => m[2] === "false")
  .map((m) => m[1]);

// ── report ───────────────────────────────────────────────────────────────────
const keyCount = Object.values(enData).reduce((n, g) => n + Object.keys(g.plain).length + Object.keys(g.plurals).length, 0);
for (const w of warnings.slice(0, 200)) console.warn(`warn  ${w}`);
if (warnings.length > 200) console.warn(`warn  … and ${warnings.length - 200} more`);
if (errors.length) {
  for (const e of errors.slice(0, 200)) console.error(`error ${e}`);
  if (errors.length > 200) console.error(`error … and ${errors.length - 200} more`);
  console.error(`\ncheck-locales: ${errors.length} problem(s) across ${targets.length} locale(s).`);
  process.exit(1);
}
console.log(`check-locales: OK — ${targets.length} locale(s) [${targets.join(", ")}] match English (${enFiles.length} namespaces, ${keyCount} keys/plural groups).`);
if (gated.length) console.log(`release gate: ready:false (hidden in production builds until reviewed): ${gated.join(", ")}`);
