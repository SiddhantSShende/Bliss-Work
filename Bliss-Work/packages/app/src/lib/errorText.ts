import { ApiError } from "@taskboard/shared";

/**
 * The sentence to show a user when a request failed.
 *
 * Prefers the SERVER's message. Every service emits the same error envelope and
 * fills `message` with something specific — "invalid email address: bob@",
 * "subject must be at most 200 characters" — which names the field the user has
 * to fix. `String(e)` would render that as "ApiError: invalid email address:
 * bob@", prefixing a class name onto an otherwise readable sentence.
 *
 * Falls back to a plain Error's message, then to the stringified value, so a
 * network failure or a thrown non-Error still says something rather than
 * rendering "[object Object]".
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError || e instanceof Error) return e.message;
  return String(e);
}
