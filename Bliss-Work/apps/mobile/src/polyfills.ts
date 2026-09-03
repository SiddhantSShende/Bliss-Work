/**
 * Web APIs `packages/shared`'s API/WS clients assume exist globally, that
 * Hermes (React Native's JS engine) does not provide on its own. Imported
 * FIRST, before anything else, in index.js — several of these patch a global
 * that other modules read once at import time.
 */
import 'react-native-get-random-values'; // patches crypto.getRandomValues
import { Buffer } from 'buffer';
import { v4 as uuidv4 } from 'uuid';

// packages/shared/src/api/client.ts calls crypto.randomUUID() directly for
// idempotency keys. react-native-get-random-values only provides
// getRandomValues, not randomUUID itself, and Hermes has neither — so this
// fills the one gap using the getRandomValues it just installed, via the
// `uuid` package already used elsewhere in the app for the same RFC4122 v4
// format.
const cryptoObj = globalThis.crypto as Crypto | undefined;
if (cryptoObj && typeof cryptoObj.randomUUID !== 'function') {
  // uuidv4()'s return is a plain `string` to TS, while Crypto.randomUUID is
  // typed as the narrower UUID template-literal shape — a real mismatch to
  // the type checker, not to the value itself (uuid's v4 output always has
  // that shape). Isolated to this one assignment rather than widening
  // Crypto.randomUUID's type everywhere it's read.
  cryptoObj.randomUUID = (() => uuidv4()) as Crypto['randomUUID'];
}

// packages/shared/src/ws-client/WsClient.ts falls back to Buffer for its
// base64url JWT-payload decode when `atob` is unavailable (true on Hermes).
// Same defensively-typed-global-cast style WsClient.ts's own Buffer check
// already uses, so this isn't a new pattern in the codebase.
const globalWithBuffer = globalThis as unknown as { Buffer?: typeof Buffer };
if (typeof globalWithBuffer.Buffer === 'undefined') {
  globalWithBuffer.Buffer = Buffer;
}
