"""Standalone Super Admin login — a single operator credential configured
via environment variables (SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD_HASH),
wholly separate from the multi-tenant org login in auth.py.

Deliberately NOT a row in `users`/`orgs`, and there is no registration
endpoint for it anywhere — the only way to obtain this credential is for
whoever controls the deployment's environment to configure it. When unset
(the default), this entire surface answers 503 rather than silently
accepting any password or falling back to some other check.

Issues a normal, fully-verified JWT via the same signing key every other
service already trusts (security/keys.py), with roles=["super_admin"] — so
downstream authorization is enforced by security/auth_dep.require_super_admin
exactly like org_admin is for the ordinary app, never by hiding a UI button.
A non-super-admin token (or no token) is rejected by that same dependency on
every protected call, independent of anything the frontend does.

Deliberately NOT integrated with auth.py's org-scoped lockout/CAPTCHA/MFA
machinery — a single operator credential, not a multi-tenant account, so
there is no `identity` row to lock, no `orgId` to scope an MFA gate to, and
no org registration flow for a CAPTCHA to protect. It still gets a tight
per-IP rate limit (see rate_limit.py's _SENSITIVE_LIMITS) and a
constant-time dummy verify on an unrecognized email, mirroring /auth/login's
enumeration defense.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ..config import settings
from ..schemas import SuperAdminLoginRequest, SuperAdminSessionDTO
from ..security.auth_dep import Principal, require_super_admin
from ..security.keys import mint_access_token
from ..security.origin import enforce_origin
from ..security.passwords import dummy_verify_async, verify_password_async

router = APIRouter(prefix="/auth/super-admin", tags=["super-admin"])

# Fixed sentinel identity — never a real row in any table. The JWT shape every
# service's verify_bearer requires (non-empty `sub` and `org_id` — see
# security/auth_dep.py) is satisfied without pointing at one.
_SENTINEL_ORG_ID = "00000000-0000-0000-0000-000000000000"
_SENTINEL_USER_ID = "super-admin"


def _configured() -> bool:
    return bool(settings.super_admin_email and settings.super_admin_password_hash)


_NOT_CONFIGURED_DETAIL = (
    "Super Admin login is not configured on this server. Set SUPER_ADMIN_EMAIL "
    "and SUPER_ADMIN_PASSWORD_HASH (see .env.example) and restart auth-svc — "
    "this surface never falls back to open registration."
)


@router.post(
    "/login", response_model=SuperAdminSessionDTO, dependencies=[Depends(enforce_origin)]
)
async def super_admin_login(body: SuperAdminLoginRequest) -> SuperAdminSessionDTO:
    if not _configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, _NOT_CONFIGURED_DETAIL)

    generic = HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    # Constant-time on a wrong email too — see passwords.dummy_verify_async's
    # docstring: this mirrors /auth/login's enumeration defense even though
    # there is exactly one account to enumerate.
    if body.email.strip().lower() != settings.super_admin_email.strip().lower():
        await dummy_verify_async()
        raise generic
    if not await verify_password_async(settings.super_admin_password_hash, body.password):
        raise generic

    token, ttl = mint_access_token(
        user_id=_SENTINEL_USER_ID,
        org_id=_SENTINEL_ORG_ID,
        roles=["super_admin"],
        username="Super Admin",
        ttl_seconds=settings.super_admin_session_ttl_seconds,
    )
    return SuperAdminSessionDTO(accessToken=token, expiresIn=ttl, email=settings.super_admin_email)


@router.get("/me", response_model=SuperAdminSessionDTO)
async def super_admin_me(_: Principal = Depends(require_super_admin)) -> SuperAdminSessionDTO:
    """Used by the dashboard route guard to confirm — against the server, not
    just a token sitting in sessionStorage — that the caller is still a valid
    Super Admin before rendering anything. Carries no fresh token: a 200 here
    means "this bearer token still works," not "here is a new one."""
    return SuperAdminSessionDTO(accessToken="", expiresIn=0, email=settings.super_admin_email)
