/**
 * Browserless CRX3 packer.
 *
 *   npm run build -w @taskboard/extension
 *   CODEBASE_URL=https://cdn.example.com/blisswork-activity.crx \
 *     node apps/extension/scripts/pack-crx.mjs
 *
 * Signs the built `dist/` into a `dist.crx` that Chrome/Edge will force-install,
 * and writes `deploy/updates.xml`. No browser, no npm dependency — Node 22's
 * `zlib.crc32` and `crypto` are all it needs, so the same command works on a
 * headless server or in CI.
 *
 * On first run it mints the RSA signing key (`blisswork-extension.pem`) and
 * prints the extension ID that key produces. KEEP THAT KEY: the ID is derived
 * from it, every enterprise policy pins that ID, and losing it means every
 * managed browser treats the next build as a different extension.
 *
 * CRX3 format (see Chromium components/crx_file): "Cr24" + u32le(3) +
 * u32le(headerLen) + CrxFileHeader(protobuf) + zip. The signature is
 * RSASSA-PKCS1v1.5/SHA-256 over "CRX3 SignedData\0" + u32le(len(signedData)) +
 * signedData + zip, where signedData carries the 16-byte crx_id.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as rsaSign, verify as rsaVerify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const EXT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(EXT, "dist");
const KEY = join(EXT, "blisswork-extension.pem");
const CRX = join(EXT, "dist.crx");
const DEPLOY = join(EXT, "deploy");
const CODEBASE_URL = process.env.CODEBASE_URL || "https://REPLACE-WITH-YOUR-HOST/blisswork-activity.crx";

if (!existsSync(DIST)) {
  console.error(`no build at ${DIST} — run: npm run build -w @taskboard/extension`);
  process.exit(1);
}

// ── the signing key ──────────────────────────────────────────────────────────
let privatePem;
if (existsSync(KEY)) {
  privatePem = readFileSync(KEY);
} else {
  console.log(`==> no signing key yet — minting ${KEY} (BACK THIS UP)`);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(KEY, privatePem, { mode: 0o600 });
}
const privateKey = createPrivateKey(privatePem);
const pubDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const crxId = createHash("sha256").update(pubDer).digest().subarray(0, 16);

// The extension ID = the crx_id's hex, each nibble mapped 0-f -> a-p.
const extId = [...crxId.toString("hex")].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join("");

// ── a stored (uncompressed) zip of dist/ ─────────────────────────────────────
// "Store" not "deflate": the whole package is a few KB, compression buys nothing,
// and a stored zip is simple enough to be provably correct here (Python's
// zipfile validates it below).
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function buildZip() {
  const DOS_DATE = 0x21; // 1980-01-01, a valid DOS date (0 is rejected by strict readers)
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of walk(DIST).sort()) {
    const nameBuf = Buffer.from(relative(DIST, file).split(sep).join("/"), "utf8");
    const data = readFileSync(file);
    const crc = crc32(data) >>> 0;
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, data,
    ]);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(centralPart.length), u32(localPart.length), u16(0),
  ]);
  return Buffer.concat([localPart, centralPart, eocd]);
}

const zip = buildZip();

// ── CRX3 header + signature (hand-encoded protobuf; only a few fields) ────────
const tag = (n) => { const b = []; let k = (n << 3) | 2; while (k > 0x7f) { b.push((k & 0x7f) | 0x80); k >>>= 7; } b.push(k); return Buffer.from(b); };
const varint = (n) => { const b = []; while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n >>>= 7; } b.push(n); return Buffer.from(b); };
const field = (num, payload) => Buffer.concat([tag(num), varint(payload.length), payload]);

const signedData = field(1, crxId);                         // SignedData { crx_id = 1 }
const magic = Buffer.from("CRX3 SignedData\0", "latin1");    // 16 bytes
const toSign = Buffer.concat([magic, u32(signedData.length), signedData, zip]);
const signature = rsaSign("sha256", toSign, privateKey);

const proof = Buffer.concat([field(1, pubDer), field(2, signature)]); // AsymmetricKeyProof
const header = Buffer.concat([field(2, proof), field(10000, signedData)]); // CrxFileHeader
const crx = Buffer.concat([Buffer.from("Cr24", "latin1"), u32(3), u32(header.length), header, zip]);
writeFileSync(CRX, crx);

// A raw copy of the inner zip, so `python3 -m zipfile` (or any zip reader) can be
// pointed at it to confirm the archive is well-formed independently of the CRX.
writeFileSync(join(EXT, "dist.zip"), zip);

// ── self-verify: the checks Chrome will make ─────────────────────────────────
const ok = [];
ok.push(["magic Cr24", crx.subarray(0, 4).toString("latin1") === "Cr24"]);
ok.push(["version 3", crx.readUInt32LE(4) === 3]);
ok.push(["crx_id = sha256(pubkey)[:16]", createHash("sha256").update(pubDer).digest().subarray(0, 16).equals(crxId)]);
ok.push(["RSA signature verifies", rsaVerify("sha256", toSign, createPublicKey(privateKey), signature)]);
for (const [name, pass] of ok) console.log(`  ${pass ? "✓" : "✗"} ${name}`);
if (ok.some(([, p]) => !p)) { console.error("self-verify FAILED — not writing updates.xml"); process.exit(1); }

// ── updates.xml from the template ────────────────────────────────────────────
const tmpl = readFileSync(join(DEPLOY, "updates.xml.tmpl"), "utf8");
writeFileSync(join(DEPLOY, "updates.xml"),
  tmpl.replaceAll("__EXTENSION_ID__", extId).replaceAll("__CODEBASE_URL__", CODEBASE_URL));

console.log(`\npacked: ${CRX}`);
console.log(`key:    ${KEY}   (back this up — the ID depends on it)`);
console.log(`ext id: ${extId}`);
console.log(`\nNext:`);
console.log(`  1. Host ${CRX} and ${join(DEPLOY, "updates.xml")} at your CDN (set CODEBASE_URL to the .crx URL and re-run).`);
console.log(`  2. Put the ID ${extId} + the updates.xml URL into deploy/chrome-policy.json / windows-forcelist.reg; push via MDM.`);
console.log(`  3. Provision each member's ingest token via the 3rdparty managed policy (deploy/README.md).`);
console.log(`\nVerify the inner archive independently:  python3 -m zipfile -t apps/extension/dist.zip`);
