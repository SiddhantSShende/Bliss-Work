/**
 * OPT-IN Windows custom-sign hook for SSL.com **eSigner / CodeSignTool** (cloud
 * HSM signing — no USB token, cross-platform Java, so it runs on the Linux VPS
 * or CI too).
 *
 * NOT active by default. To enable it, add this to package.json → build.win:
 *     "sign": "build/sign-win.cjs"
 * and STOP setting CSC_LINK (a custom `sign` replaces electron-builder's default
 * signing). Then provide the eSigner credentials + tool path via env:
 *
 *     ES_USERNAME          – SSL.com account username
 *     ES_PASSWORD          – SSL.com account password
 *     ES_CREDENTIAL_ID     – eSigner signing credential id
 *     ES_TOTP_SECRET       – eSigner TOTP secret (for automated 2FA)
 *     CODE_SIGN_TOOL_PATH  – path to CodeSignTool.sh (Linux/mac) or CodeSignTool.bat (Windows)
 *
 * Requires a JRE 11+ on the build host (VPS: `sudo apt install default-jre unzip`),
 * OR use SSL.com's Docker image / `sslcom/esigner-codesign` GitHub Action instead
 * of this hook.
 *
 * ⚠️  Verify the exact CodeSignTool flags against SSL.com's CURRENT docs + your
 *     downloaded CodeSignTool version — the CLI has changed across releases.
 *     Docs: https://www.ssl.com/guide/esigner-codesigntool-command-guide/
 *     electron-builder integration: https://www.ssl.com/how-to/electron-code-signing/
 *
 * If the env vars are absent, this NO-OPs (leaves the file unsigned) so a plain
 * `electron-builder --win` still produces an (unsigned) installer for testing.
 */
const { execFileSync } = require("node:child_process");
const { mkdtempSync, copyFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, basename } = require("node:path");

module.exports = async function sign(configuration) {
  const file = configuration.path;
  const { ES_USERNAME, ES_PASSWORD, ES_CREDENTIAL_ID, ES_TOTP_SECRET, CODE_SIGN_TOOL_PATH } = process.env;

  if (!ES_USERNAME || !ES_PASSWORD || !ES_CREDENTIAL_ID || !ES_TOTP_SECRET || !CODE_SIGN_TOOL_PATH) {
    console.log(`[sign-win] eSigner env not set — leaving ${basename(file)} UNSIGNED (test build).`);
    return;
  }

  // CodeSignTool writes the signed artifact into an output DIR (same basename),
  // so sign into a temp dir then copy the signed file back over the original.
  const outDir = mkdtempSync(join(tmpdir(), "esigner-"));
  console.log(`[sign-win] SSL.com eSigner: signing ${basename(file)} (cloud HSM)…`);
  execFileSync(
    CODE_SIGN_TOOL_PATH,
    [
      "sign",
      `-username=${ES_USERNAME}`,
      `-password=${ES_PASSWORD}`,
      `-credential_id=${ES_CREDENTIAL_ID}`,
      `-totp_secret=${ES_TOTP_SECRET}`,
      `-input_file_path=${file}`,
      `-output_dir_path=${outDir}`,
    ],
    { stdio: "inherit" },
  );
  copyFileSync(join(outDir, basename(file)), file);
  console.log(`[sign-win] signed ${basename(file)} ✓`);
};
