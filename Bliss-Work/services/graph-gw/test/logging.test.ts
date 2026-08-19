/**
 * Structured logging, and the one rule that is a security control rather than a
 * formatting preference: a bearer token must never reach a log line.
 *
 * This gateway holds a caller's credential on every single request and passes
 * the whole request context around. One `log.info("x", { caller })` is all it
 * would take to write live access tokens into Loki, where they are searchable,
 * replicated and retained. So redaction lives in the logger itself rather than
 * in the discipline of every call site.
 */
import { describe, expect, it } from "vitest";
import { createLogger, parseLevel, redact } from "../src/logging.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger("debug", {}, (line) => lines.push(JSON.parse(line)));
  return { log, lines };
}

describe("createLogger", () => {
  it("emits one JSON object per line, with the event as a field", () => {
    const { log, lines } = capture();
    log.info("upstream_failed", { service: "auth-svc" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      event: "upstream_failed",
      service: "auth-svc",
    });
    expect(typeof lines[0]!.ts).toBe("string");
  });

  it("drops lines below the configured level", () => {
    const lines: string[] = [];
    const log = createLogger("warn", {}, (l) => lines.push(l));
    log.debug("noise");
    log.info("noise");
    log.warn("kept");
    log.error("kept");
    expect(lines).toHaveLength(2);
  });

  it("stamps a child logger's fields on every line", () => {
    const { log, lines } = capture();
    log.with({ request_id: "req-7" }).info("handled");
    expect(lines[0]).toMatchObject({ request_id: "req-7" });
  });

  it("does not let a child logger's fields leak back to the parent", () => {
    const { log, lines } = capture();
    log.with({ request_id: "req-7" }).info("child");
    log.info("parent");
    expect(lines[1]).not.toHaveProperty("request_id");
  });
});

describe("redaction", () => {
  it("redacts an Authorization header at the top level", () => {
    const { log, lines } = capture();
    log.info("req", { authorization: "Bearer eyJhbGciOi.SECRET" });
    expect(JSON.stringify(lines[0])).not.toContain("SECRET");
    expect(lines[0]!.authorization).toBe("[redacted]");
  });

  it("redacts a token nested inside the caller context", () => {
    // The realistic accident: logging the whole context object.
    const { log, lines } = capture();
    log.error("boom", {
      caller: { authorization: "Bearer eyJ.SECRET", forwarded: { "x-request-id": "r1" } },
    });
    const rendered = JSON.stringify(lines[0]);
    expect(rendered).not.toContain("SECRET");
    expect(rendered).toContain("r1"); // harmless fields survive
  });

  it.each([
    "authorization",
    "Authorization",
    "AUTHORIZATION",
    "access_token",
    "accessToken",
    "refresh-token",
    "password",
    "cookie",
    "set-cookie",
    "apiKey",
    "secret",
  ])("redacts %s however it is spelled", (key) => {
    const { log, lines } = capture();
    log.info("x", { [key]: "SECRET" });
    expect(JSON.stringify(lines[0])).not.toContain("SECRET");
  });

  it("redacts inside arrays", () => {
    const { log, lines } = capture();
    log.info("x", { headers: [{ authorization: "SECRET" }] });
    expect(JSON.stringify(lines[0])).not.toContain("SECRET");
  });

  it("terminates on a cyclic object instead of hanging the process", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it("leaves ordinary values alone", () => {
    expect(redact({ service: "auth-svc", status: 503, ok: false })).toEqual({
      service: "auth-svc",
      status: 503,
      ok: false,
    });
  });
});

describe("parseLevel", () => {
  it("accepts the four levels", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(parseLevel(level)).toBe(level);
    }
  });

  it("falls back to info for anything else, including undefined", () => {
    // A typo in LOG_LEVEL must not silence the service.
    expect(parseLevel(undefined)).toBe("info");
    expect(parseLevel("")).toBe("info");
    expect(parseLevel("verbose")).toBe("info");
  });

  it("is case-insensitive", () => {
    expect(parseLevel("WARN")).toBe("warn");
  });
});
