#!/usr/bin/env node
/**
 * Guard: no Office file is opened, parsed or rendered outside the Office Document
 * Sandbox (services/doc-converter).
 *
 * BlissWork treats DOC/DOCX/XLS/XLSX/PPT/PPTX as hostile input. The ONLY code
 * allowed to read one is the sandbox, which runs LibreOffice in an isolated
 * container. Everything else — every service, the web app, the desktop app — only
 * moves the bytes and shows what the sandbox returns (a PDF, or plain cell text).
 *
 *   node scripts/check-no-office-readers.mjs            # the whole repo
 *   node scripts/check-no-office-readers.mjs --root DIR # another tree (the tests plant violations in one)
 *
 * It fails (exit 1) on a dependency, an import or a call that would read an
 * Office document anywhere but services/doc-converter. `exceljs` is allowed — the
 * app uses it to WRITE exports — but not its readers (`.xlsx.load/read/readFile`).
 * Zero dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = path.resolve(rootArg >= 0 ? args[rootArg + 1] : path.join(here, ".."));

/** The one place allowed to read Office files. */
const ALLOWED = ["services/doc-converter"];

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "release", "build", ".venv", "venv", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", ".vite", ".turbo", ".next", "loadtest", "scan-reports", ".deploy", "coverage",
]);

// Libraries whose job is to read Office documents.
const JS_LIBS = [
  "mammoth", "docx-preview", "pptx-preview", "xlsx", "xlsx-populate", "node-xlsx", "read-excel-file",
  "officeparser", "word-extractor", "pizzip", "docxtemplater", "adm-zip", "jszip", "unzipper", "yauzl", "fflate",
];
const PY_LIBS = ["python-docx", "docx", "docx2txt", "openpyxl", "xlrd", "xlwt", "pptx", "python-pptx", "olefile", "oletools", "mammoth", "xlsx2csv", "pyxlsb"];
const PY_MODULES = ["docx", "docx2txt", "openpyxl", "xlrd", "pptx", "olefile", "oletools", "mammoth", "xlsx2csv", "pyxlsb"];
const GO_LIBS = ["excelize", "unioffice", "unidoc", "tealeg/xlsx", "nguyenthenguyen/docx", "sassoftware/go-docx"];
const GO_STD = ["archive/zip"];
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

const violations = [];
const flag = (file, what) => violations.push(`${path.relative(root, file)}: ${what}`);

const isAllowed = (file) => {
  const rel = path.relative(root, file).split(path.sep).join("/");
  return ALLOWED.some((a) => rel === a || rel.startsWith(a + "/"));
};

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      // Third-party trees (including differently-named Python virtualenvs) are not our code.
      if (SKIP_DIRS.has(e.name) || e.name === "site-packages" || /^\.?venv/.test(e.name)) continue;
      yield* walk(path.join(dir, e.name));
    } else if (e.isFile()) yield path.join(dir, e.name);
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const jsImport = new RegExp(
  String.raw`(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'](?:${JS_LIBS.map(esc).join("|")})(?:/[^"']*)?["']`,
);
const exceljsReader = /\.\s*(?:xlsx|csv)\s*\.\s*(?:load|read|readFile)\s*\(/;
const pyImport = new RegExp(String.raw`^\s*(?:from\s+(?:${PY_MODULES.join("|")})(?:\.\w+)*\s+import|import\s+(?:${PY_MODULES.join("|")})\b)`, "m");
const goImport = new RegExp(String.raw`"(?:[^"]*/)?(?:${[...GO_LIBS, ...GO_STD].map(esc).join("|")})(?:/[^"]*)?"`);

for (const file of walk(root)) {
  if (isAllowed(file)) continue;
  const base = path.basename(file);

  if (base === "package.json") {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const sec of DEP_SECTIONS) for (const name of Object.keys(json[sec] ?? {})) if (JS_LIBS.includes(name)) flag(file, `declares ${name} (${sec})`);
  } else if (/^requirements.*\.txt$/.test(base) || base === "pyproject.toml") {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const name = line.trim().split(/[=<>~! \[;#]/)[0]?.toLowerCase();
      if (name && PY_LIBS.includes(name)) flag(file, `lists ${name}`);
    }
  } else if (base === "go.mod") {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) if (GO_LIBS.some((l) => line.includes(l))) flag(file, `requires ${line.trim()}`);
  } else if (/\.(?:[cm]?[jt]sx?)$/.test(base)) {
    // This script and its own test name the libraries on purpose.
    if (file === fileURLToPath(import.meta.url) || base === "noOfficeReaders.test.ts") continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.length > 2_000_000) continue; // generated/minified
    const m = jsImport.exec(text);
    if (m) flag(file, `imports an Office reader: ${m[0].trim()}`);
    if (exceljsReader.test(text)) flag(file, "calls an exceljs reader (.xlsx/.csv .load/.read/.readFile); exceljs is for writing exports only");
  } else if (base.endsWith(".py")) {
    if (pyImport.test(fs.readFileSync(file, "utf8"))) flag(file, "imports an Office reader");
  } else if (base.endsWith(".go") && !base.endsWith("_test.go")) {
    if (goImport.test(fs.readFileSync(file, "utf8"))) flag(file, "imports an Office reader or archive/zip");
  }
}

if (violations.length) {
  console.error(`check-no-office-readers: ${violations.length} violation(s) — Office files may only be read inside services/doc-converter:`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("check-no-office-readers: OK — no Office reader outside services/doc-converter");
