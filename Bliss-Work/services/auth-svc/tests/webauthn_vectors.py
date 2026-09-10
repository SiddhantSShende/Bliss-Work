"""Hand-built, cryptographically-real WebAuthn ceremony test vectors.

A real browser/authenticator ceremony cannot run inside a backend test — the
Phase 7 plan says so plainly rather than pretending otherwise (see
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7's Tests section). What CAN run,
and what this module builds, is a genuine FIDO2 registration/authentication
response: real Ed25519 keys, real CBOR-encoded attestation objects, real
signatures over the real authenticatorData+clientDataHash — verified against
the actual `webauthn` library, not a mock of it. Only the "authenticator"
itself (a plain Ed25519 keypair standing in for a hardware key or platform
authenticator) is synthetic.

Ed25519, not the more common ECDSA P-256, purely because this codebase
already uses `cryptography`'s Ed25519 API elsewhere (security/keys.py) — one
fewer new crypto shape to reason about, and the `webauthn` library treats
both algorithms identically for verification purposes.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os

import cbor2
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def cose_ed25519_public_key(pub_raw: bytes) -> bytes:
    """COSE_Key CBOR for an OKP/Ed25519 public key: kty=OKP(1), alg=EdDSA(-8),
    crv=Ed25519(6), x=<raw 32-byte point>."""
    return cbor2.dumps({1: 1, 3: -8, -1: 6, -2: pub_raw})


def _authenticator_data(
    rp_id: str, *, sign_count: int, uv: bool = False, attested: tuple[bytes, bytes] | None = None
) -> bytes:
    rp_id_hash = hashlib.sha256(rp_id.encode("utf-8")).digest()
    flags = 0x01 | (0x04 if uv else 0) | (0x40 if attested is not None else 0)  # UP | UV | AT
    data = rp_id_hash + bytes([flags]) + sign_count.to_bytes(4, "big")
    if attested is not None:
        credential_id, cose_public_key = attested
        aaguid = b"\x00" * 16
        data += aaguid + len(credential_id).to_bytes(2, "big") + credential_id + cose_public_key
    return data


class WebauthnAuthenticator:
    """A synthetic authenticator: one Ed25519 keypair + credential id, able to
    produce a registration response and then any number of authentication
    responses at a chosen sign_count."""

    def __init__(self) -> None:
        self.private_key = Ed25519PrivateKey.generate()
        self.public_key_raw = self.private_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )
        self.credential_id = os.urandom(32)
        self.cose_public_key = cose_ed25519_public_key(self.public_key_raw)

    def _sign(self, authenticator_data: bytes, client_data_json: bytes) -> bytes:
        return self.private_key.sign(authenticator_data + hashlib.sha256(client_data_json).digest())

    def registration_response(
        self, *, rp_id: str, origin: str, challenge: bytes, sign_count: int = 0
    ) -> dict:
        authenticator_data = _authenticator_data(
            rp_id, sign_count=sign_count, attested=(self.credential_id, self.cose_public_key)
        )
        client_data_json = json.dumps(
            {
                "type": "webauthn.create",
                "challenge": b64url(challenge),
                "origin": origin,
                "crossOrigin": False,
            }
        ).encode("utf-8")
        # fmt: "none" attestation carries no attStmt signature — only the
        # (unattested) authenticator assertion below is actually signed.
        attestation_object = cbor2.dumps(
            {"fmt": "none", "attStmt": {}, "authData": authenticator_data}
        )
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(client_data_json),
                "attestationObject": b64url(attestation_object),
            },
            "clientExtensionResults": {},
        }

    def authentication_response(
        self, *, rp_id: str, origin: str, challenge: bytes, sign_count: int, uv: bool = False
    ) -> dict:
        authenticator_data = _authenticator_data(rp_id, sign_count=sign_count, uv=uv)
        client_data_json = json.dumps(
            {
                "type": "webauthn.get",
                "challenge": b64url(challenge),
                "origin": origin,
                "crossOrigin": False,
            }
        ).encode("utf-8")
        signature = self._sign(authenticator_data, client_data_json)
        return {
            "id": b64url(self.credential_id),
            "rawId": b64url(self.credential_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(client_data_json),
                "authenticatorData": b64url(authenticator_data),
                "signature": b64url(signature),
            },
            "clientExtensionResults": {},
        }
