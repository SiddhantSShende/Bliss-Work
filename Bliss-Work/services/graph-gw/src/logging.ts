/**
 * Structured logging.
 *
 * One JSON object per line, matching the shape the Python services emit through
 * structlog — `event` names the thing that happened, everything else is a field.
 * Loki indexes these, so a free-text message with values interpolated into it is
 * a line nobody can query.
 *
 * `request_id` is the correlation key across the whole platform. It arrives on
 * the inbound request, is forwarded to every upstream call, and is stamped on
 * every line logged while handling that request.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** A child logger that stamps `fields` on every line — one per request. */
  with(fields: Record<string, unknown>): Logger;
}

/** Keys whose values must never reach a log line, at any nesting level.
 *  The gateway handles a bearer token on every single request; a logger that
 *  can be handed the whole request context is one careless call away from
 *  writing credentials to Loki. */
const REDACTED_KEYS = new Set(
  [
    "authorization",
    "token",
    "access_token",
    "refresh_token",
    "password",
    "cookie",
    "set-cookie",
    "secret",
    "api_key",
  ].map(normalizeKey),
);

/** Compare keys with separators and case removed, so `set-cookie`, `setCookie`
 *  and `SET_COOKIE` are one entry. Both sides MUST go through this — a
 *  deny-list holding a raw `"set-cookie"` never matches a normalized lookup,
 *  which is a redaction rule that silently does nothing. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export function redact(value: unknown, depth = 0): unknown {
  // Bound the walk: a cyclic or pathological object must not hang the logger.
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(normalizeKey(key))
      ? "[redacted]"
      : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(
  minLevel: LogLevel = "info",
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stdout.write(line + "\n"),
): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    sink(
      JSON.stringify({
        level,
        event,
        service: "graph-gw",
        // ISO-8601 in UTC, the same stamp the other services log.
        ts: new Date().toISOString(),
        ...base,
        ...(redact(fields ?? {}) as Record<string, unknown>),
      }),
    );
  };

  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    with: (fields) => createLogger(minLevel, { ...base, ...(redact(fields) as object) }, sink),
  };
}

export function parseLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? "").toLowerCase();
  return value in LEVEL_ORDER ? (value as LogLevel) : "info";
}
