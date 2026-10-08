// A tiny JWKS endpoint for the scratch stack, plus the signing key the driver reads.
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "t", alg: "EdDSA", use: "sig" };
writeFileSync(`${process.env.WORK}/key.pem`, privateKey.export({ format: "pem", type: "pkcs8" }));
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ keys: [jwk] }));
}).listen(Number(process.env.JWKS_PORT), "127.0.0.1");
