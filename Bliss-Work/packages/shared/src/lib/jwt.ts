/**
 * Decode a JWT's payload WITHOUT verifying its signature.
 *
 * For claims auth-svc explicitly documents as non-authoritative routing/
 * correlation metadata — `sid` (session id, mint_access_token) and
 * `memberships` — never for anything that grants access: the server is
 * always the authority for authorization, and nothing here can be trusted
 * to mean what it claims (a caller could hand in an arbitrary string).
 *
 * Works in both the browser (atob) and Electron's utilityProcess/Node
 * (Buffer). Returns null for anything that isn't a parseable JWT — a bad
 * token should read as "no claim available", never throw.
 */
export function decodeJwtPayload<T = Record<string, unknown>>(
  token: string | undefined | null,
): T | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(decodeBase64Url(payload)) as T;
  } catch {
    return null;
  }
}

function decodeBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  if (typeof atob === "function") return atob(b64 + pad);
  const B = (
    globalThis as { Buffer?: { from: (s: string, e: string) => { toString: (e: string) => string } } }
  ).Buffer;
  if (B) return B.from(b64 + pad, "base64").toString("binary");
  return "";
}
