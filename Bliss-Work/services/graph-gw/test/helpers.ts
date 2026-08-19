/** Shared fixtures. Not a test file — vitest only collects `*.test.ts`. */
import { loadConfig, type GatewayConfig } from "../src/config.js";
import type { CallerContext } from "../src/upstream.js";

export const AUTH_BASE = "http://auth-svc:8001";
export const MESSAGING_BASE = "http://messaging-svc:8004";

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const base = loadConfig({
    NODE_ENV: "test",
    AUTH_BASE,
    MESSAGING_BASE,
  } as NodeJS.ProcessEnv);
  return { ...base, ...overrides };
}

export const CALLER: CallerContext = {
  authorization: "Bearer test-token",
  forwarded: { "x-request-id": "req-1" },
};

export function userRow(id: string, name: string) {
  return {
    id,
    orgId: "00000000-0000-4000-8000-00000000000a",
    orgName: "Acme",
    username: name.toLowerCase(),
    displayName: name,
    email: `${name.toLowerCase()}@acme.test`,
    roles: ["member"],
    emailVerified: true,
    plan: "free",
  };
}

export function peerRow(peerId: string, name: string) {
  return {
    peerId,
    username: name.toLowerCase(),
    displayName: name,
    lastEventAt: "2026-08-19T00:00:00.000Z",
    unreadCount: 0,
    itemCount: 1,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** UUIDs that read as what they are in a failure message. */
export const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
