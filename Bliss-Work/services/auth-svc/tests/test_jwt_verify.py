"""Token-verification security tests for ``app.security.auth_dep.verify_bearer``.

These target verify_bearer rather than the get_principal dependency, because
verify_bearer IS the verification: get_principal is now a thin wrapper that
reuses whatever PrincipalMiddleware already verified for this request and
falls through to verify_bearer otherwise. Pointing the security assertions at
the wrapper would test the cache lookup, not the signature check.

The JWKS fetch is bypassed by monkeypatching the cache's get_key with a known
Ed25519 public key, so these exercise the REAL decode/verify path (algorithm,
issuer, expiry, kid, required claims, signature) against forged tokens:

  * valid EdDSA token -> Principal with claims from VERIFIED token only
  * missing/!Bearer header, unknown kid, wrong issuer, expired, missing claims,
    tampered signature, and alg=none / HS256-confusion are all rejected (401)

Skips cleanly if fastapi/jwt/cryptography aren't installed locally.
"""
from __future__ import annotations

import time

import pytest

jwt = pytest.importorskip("jwt", reason="PyJWT not installed locally; CI installs requirements.txt.")
auth_dep = pytest.importorskip(
    "app.security.auth_dep",
    reason="auth-svc deps not installed locally; CI installs requirements.txt.",
)
settings = pytest.importorskip("app.config").settings
HTTPException = pytest.importorskip("fastapi").HTTPException
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

KID = "test-kid"
_priv = Ed25519PrivateKey.generate()
_pub = _priv.public_key()


@pytest.fixture(autouse=True)
def _inject_key(monkeypatch):
    async def fake_get_key(kid):
        return _pub if kid == KID else None

    monkeypatch.setattr(auth_dep._jwks_cache, "get_key", fake_get_key)


def _token(claims=None, *, kid=KID, key=None, alg="EdDSA"):
    now = int(time.time())
    payload = {
        "sub": "user-1",
        "org_id": "org-1",
        "iss": settings.jwt_issuer,
        "iat": now,
        "exp": now + 300,
        "roles": ["member"],
        "username": "alice",
    }
    if claims:
        payload.update(claims)
    return jwt.encode(payload, key or _priv, algorithm=alg, headers={"kid": kid})


async def _principal(token):
    return await auth_dep.verify_bearer(f"Bearer {token}")


@pytest.mark.asyncio
async def test_valid_token_yields_principal():
    p = await _principal(_token())
    assert p.user_id == "user-1" and p.org_id == "org-1" and "member" in p.roles


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "header",
    [None, "", "token-without-bearer", "Basic abc"],
)
async def test_missing_or_malformed_bearer_rejected(header):
    with pytest.raises(HTTPException) as e:
        await auth_dep.verify_bearer(header)
    assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_unknown_kid_rejected():
    with pytest.raises(HTTPException) as e:
        await _principal(_token(kid="other-kid"))
    assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_wrong_issuer_rejected():
    with pytest.raises(HTTPException) as e:
        await _principal(_token({"iss": "evil-issuer"}))
    assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_expired_rejected():
    now = int(time.time())
    with pytest.raises(HTTPException) as e:
        await _principal(_token({"iat": now - 1000, "exp": now - 500}))
    assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_missing_required_claims_rejected():
    # No org_id -> incomplete claims.
    tok = _token()
    payload = jwt.decode(tok, _pub, algorithms=["EdDSA"], options={"verify_signature": False})
    payload.pop("org_id")
    bad = jwt.encode(payload, _priv, algorithm="EdDSA", headers={"kid": KID})
    with pytest.raises(HTTPException) as e:
        await _principal(bad)
    assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_tampered_signature_rejected():
    tok = _token()
    head, body, _sig = tok.split(".")
    forged = f"{head}.{body}.AAAertytampered"
    with pytest.raises(HTTPException) as e:
        await _principal(forged)
    assert e.value.status_code == 401


@pytest.mark.asyncio
async def test_alg_none_rejected():
    # Unsigned "alg: none" token must never be accepted.
    unsigned = jwt.encode({"sub": "x", "org_id": "o", "iss": settings.jwt_issuer}, key=None, algorithm="none", headers={"kid": KID})
    with pytest.raises(HTTPException) as e:
        await _principal(unsigned)
    assert e.value.status_code == 401
