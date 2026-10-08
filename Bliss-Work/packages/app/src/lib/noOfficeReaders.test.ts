import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Office files (DOC/DOCX/XLS/XLSX/PPT/PPTX) are hostile input and may only be read
 * inside the Office Document Sandbox, services/doc-converter. This runs the guard
 * (scripts/check-no-office-readers.mjs) against the real repo, and against trees
 * with violations planted in them, to prove it would notice.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const script = path.join(repo, "scripts/check-no-office-readers.mjs");

function check(root: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, "--root", root], { encoding: "utf8", stdio: "pipe" });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-office-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("no Office reader outside the sandbox", () => {
  it("the real repository is clean", () => {
    const r = check(repo);
    expect(r.out).toContain("OK");
    expect(r.ok).toBe(true);
  });

  it.each([
    ["a JS dependency", { "apps/web/package.json": '{"dependencies":{"mammoth":"1.0.0"}}' }, "declares mammoth"],
    ["a SheetJS dependency", { "packages/x/package.json": '{"devDependencies":{"xlsx":"0.18.5"}}' }, "declares xlsx"],
    ["a direct jszip dependency", { "packages/x/package.json": '{"dependencies":{"jszip":"3"}}' }, "declares jszip"],
    ["an import of a reader", { "packages/app/src/a.ts": 'import m from "docx-preview";' }, "imports an Office reader"],
    ["a dynamic import of a reader", { "apps/web/a.ts": 'const x = await import("pptx-preview");' }, "imports an Office reader"],
    ["a require of a reader", { "services/graph-gw/a.js": 'const x = require("officeparser");' }, "imports an Office reader"],
    ["an exceljs READ", { "packages/app/src/b.ts": "await wb.xlsx.load(buffer);" }, "exceljs reader"],
    ["an exceljs file read", { "packages/app/src/b.ts": "await wb.xlsx.readFile(p);" }, "exceljs reader"],
    ["a Python reader import", { "services/a/app/x.py": "import openpyxl\n" }, "imports an Office reader"],
    ["a Python reader dependency", { "services/a/requirements.txt": "python-docx==1.1\n" }, "lists python-docx"],
    ["a Go office module", { "services/b/go.mod": "module b\nrequire github.com/xuri/excelize/v2 v2.8.0\n" }, "requires"],
    ["archive/zip in a Go service", { "services/b/x.go": 'package x\nimport "archive/zip"\n' }, "archive/zip"],
  ])("fails on %s", (_label, files, expected) => {
    const r = check(tree(files));
    expect(r.ok).toBe(false);
    expect(r.out).toContain(expected);
  });

  it("allows all of it inside services/doc-converter, the sandbox itself", () => {
    const r = check(
      tree({
        "services/doc-converter/app/x.py": "import openpyxl\n",
        "services/doc-converter/requirements.txt": "openpyxl==3\n",
        "services/doc-converter/extra/a.js": 'import m from "mammoth";',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("allows exceljs to WRITE exports", () => {
    const r = check(
      tree({
        "packages/app/package.json": '{"dependencies":{"exceljs":"^4.4.0"}}',
        "packages/app/src/w.ts": 'const ExcelJS = await import("exceljs"); const wb = new ExcelJS.Workbook(); await wb.xlsx.writeBuffer();',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("does not look inside third-party trees", () => {
    const r = check(
      tree({
        "services/a/.venv-check/lib/python3.13/site-packages/PIL/Plugin.py": "import olefile\n",
        "node_modules/mammoth/index.js": 'require("jszip");',
      }),
    );
    expect(r.ok).toBe(true);
  });
});
