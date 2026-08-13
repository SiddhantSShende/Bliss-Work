/**
 * Generate the dev Ed25519 (EdDSA) keypair used by auth-svc to sign JWTs and
 * publish JWKS. Writes PEM files to ./keys/. Idempotent: skips if both exist.
 *
 *   npm run gen:keys
 *
 * NOTE: the private key is written 0600, owned by you. auth-svc runs as uid
 * 10001 and mounts ./keys read-only, so unless your uid happens to be 10001 the
 * container cannot read it and dies at startup with PermissionError. After
 * generating, hand it over:
 *
 *   sudo chown -R 10001:10001 keys
 *
 * That is what production does too. Do NOT chmod it 0644 instead — these are
 * throwaway dev keys, but the habit isn't.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const keysDir = resolve(process.cwd(), "keys");
const privPath = resolve(keysDir, "ed25519_private.pem");
const pubPath = resolve(keysDir, "ed25519_public.pem");

if (existsSync(privPath) && existsSync(pubPath)) {
  console.log("keys already exist, skipping:", keysDir);
  process.exit(0);
}

mkdirSync(keysDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
  mode: 0o600,
});
writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }) as string);

console.log("Generated Ed25519 dev keypair:");
console.log("  private:", privPath);
console.log("  public: ", pubPath);
