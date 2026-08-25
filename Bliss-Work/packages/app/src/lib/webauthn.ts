/**
 * WebAuthn ceremony helpers: the server's options come back JSON-encoded with
 * every buffer as base64url (per the spec — see auth-svc's
 * `options_to_json_dict`), but `navigator.credentials.create/get` want real
 * ArrayBuffers, and what they return has to travel back to the server as JSON
 * again. This module is the round trip in both directions, kept in one place
 * so the encoding never drifts between the enrollment page and the login
 * challenge page that both need it.
 */

function base64urlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True when this browser can attempt a WebAuthn ceremony at all — gates
 *  whether the "add a passkey" / "use a passkey" affordances render. */
export function webauthnSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

/** Decode the server's registration options and run the ceremony. Returns the
 *  raw credential JSON exactly as the server's register/finish endpoint wants
 *  it — never parse or re-shape it further. */
export async function createPasskey(optionsJson: Record<string, unknown>): Promise<unknown> {
  const publicKey = decodeCreationOptions(optionsJson);
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential;
  return encodeAttestationCredential(credential);
}

/** Decode the server's authentication options and run the ceremony. */
export async function getPasskeyAssertion(optionsJson: Record<string, unknown>): Promise<unknown> {
  const publicKey = decodeRequestOptions(optionsJson);
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential;
  return encodeAssertionCredential(credential);
}

function decodeCreationOptions(o: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const user = o.user as Record<string, unknown>;
  const excludeCredentials = (o.excludeCredentials as Record<string, unknown>[] | undefined) ?? [];
  return {
    ...o,
    challenge: base64urlToBuffer(o.challenge as string),
    user: { ...user, id: base64urlToBuffer(user.id as string) },
    excludeCredentials: excludeCredentials.map((c) => ({
      ...c,
      id: base64urlToBuffer(c.id as string),
    })),
  } as unknown as PublicKeyCredentialCreationOptions;
}

function decodeRequestOptions(o: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const allowCredentials = (o.allowCredentials as Record<string, unknown>[] | undefined) ?? [];
  return {
    ...o,
    challenge: base64urlToBuffer(o.challenge as string),
    allowCredentials: allowCredentials.map((c) => ({
      ...c,
      id: base64urlToBuffer(c.id as string),
    })),
  } as unknown as PublicKeyCredentialRequestOptions;
}

function encodeAttestationCredential(credential: PublicKeyCredential): unknown {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

function encodeAssertionCredential(credential: PublicKeyCredential): unknown {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}
