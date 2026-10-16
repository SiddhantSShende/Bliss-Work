export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const buildEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;

/** Defaults to debug diagnostics only in Vite development builds. */
export const isDevelopmentBuild = buildEnv?.DEV === true;

let minimumLevel: LogLevel = isDevelopmentBuild ? "debug" : "warn";

const SENSITIVE_KEY =
  /(?:token|authorization|cookie|password|secret|api[-_]?key|session|request[-_]?id|trace[-_]?id|correlation[-_]?id|user(?:name|id)?|display[-_]?name|sender[-_]?name|recipient[-_]?name|author[-_]?name|actor[-_]?name|email|phone|address|payload|body|content|message|variables|identity|participant|(?:event|sender|recipient|thread|mail|task|attachment|project|tenant|workspace|member|peer|conversation|channel|org(?:anization)?|device|call|room|client)[-_]?id|(?:^|[-_])id(?:$|[-_]))/i;

function redactString(value: string): string {
  const bounded = value.length > 2_000 ? `${value.slice(0, 2_000)}...[truncated]` : value;
  return bounded
    .replace(/\b(?:https?|wss?):\/\/[^\s"'`),]+/gi, "[REDACTED_URL]")
    .replace(/\b(?:bearer|basic)\s+[^\s"'`,;]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(
      /\b([a-z][a-z0-9_-]{0,50})["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^"'&,;\s}]+)/gi,
      (field, key: string) => (SENSITIVE_KEY.test(key) ? `${key}=[REDACTED]` : field),
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]")
    .replace(/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, "[REDACTED_PHONE]");
}

function safeValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return String(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[TRUNCATED]";

  if (value instanceof Error) {
    return {
      name: redactString(value.name),
      message: redactString(value.message),
    };
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => safeValue(item, seen, depth + 1));
  }

  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    safe[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : safeValue(item, seen, depth + 1);
  }
  return safe;
}

export function setLogLevel(level: LogLevel): void {
  minimumLevel = level;
}

export function getLogLevel(): LogLevel {
  return minimumLevel;
}

function write(level: Exclude<LogLevel, "silent">, args: unknown[]): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minimumLevel]) return;
  const safeArgs = args.map((arg) => safeValue(arg));
  switch (level) {
    case "debug":
      console.debug(...safeArgs);
      break;
    case "info":
      console.info(...safeArgs);
      break;
    case "warn":
      console.warn(...safeArgs);
      break;
    case "error":
      console.error(...safeArgs);
      break;
  }
}

export const logger = {
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};
