"""Request/response models matching the canonical TS contract DTOs."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

Role = Literal["org_admin", "member"]

# A client-resized avatar (packages/app/src/lib/thumbnail.ts: 480px longest
# edge, webp @ 0.72 quality) is on the order of tens of KB base64-encoded.
# This caps the request body well above that while still refusing a
# multi-MB payload sent straight to the API, bypassing the client resize.
MAX_AVATAR_DATA_URL_LENGTH = 500_000
_AVATAR_DATA_URL_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$")


# ── Requests ──────────────────────────────────────────────────────────────────
# Upper bounds on every free-text field: without them a client can submit
# multi-MB strings — storage bloat, and (for passwords) an expensive Argon2
# verify of a huge input is a cheap DoS. 256 is well above any real password;
# the hasher only needs the first bytes anyway.
class CreateOrgRequest(BaseModel):
    orgName: str = Field(min_length=1, max_length=100)
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    displayName: str = Field(min_length=1, max_length=80)
    # Optional at the schema level so CAPTCHA_ENABLED=false callers (dev/CI
    # tooling that cannot solve an image challenge) needn't send them at all;
    # captcha_service.verify_and_consume is what actually enforces presence
    # whenever the feature is on. See routes/captcha_service.py.
    captchaId: str | None = Field(default=None, max_length=64)
    captchaValue: str | None = Field(default=None, max_length=64)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    captchaId: str | None = Field(default=None, max_length=64)
    captchaValue: str | None = Field(default=None, max_length=64)


class RefreshRequest(BaseModel):
    token: str | None = Field(default=None, max_length=4096)


class CreateInviteRequest(BaseModel):
    email: EmailStr
    role: Role


class AcceptInviteRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=8, max_length=256)
    displayName: str = Field(min_length=1, max_length=80)
    username: str = Field(min_length=1, max_length=50)


class UpdateProfileRequest(BaseModel):
    # Both optional and independently settable: a display-name save and an
    # avatar upload are two different actions in the UI that happen to share
    # this one endpoint (see routes/auth.py's update_me) rather than a form
    # that always submits both.
    displayName: str | None = Field(default=None, min_length=1, max_length=80)
    avatarUrl: str | None = Field(default=None, max_length=MAX_AVATAR_DATA_URL_LENGTH)

    @field_validator("avatarUrl")
    @classmethod
    def _validate_avatar_url(cls, v: str | None) -> str | None:
        if v is not None and not _AVATAR_DATA_URL_RE.match(v):
            raise ValueError(
                "avatarUrl must be a data: URI with image/jpeg, image/png, or image/webp"
            )
        return v


class ChangeRoleRequest(BaseModel):
    role: Role


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)
    password: str = Field(min_length=8, max_length=256)


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)


# ── Responses ─────────────────────────────────────────────────────────────────
class UserDTO(BaseModel):
    id: str
    orgId: str
    orgName: str = ""
    username: str
    displayName: str
    email: str
    roles: list[Role]
    emailVerified: bool = True
    # Org subscription plan (entitlements). 'enterprise' unlocks External
    # Integrations + message forward-tracking. Defaults 'free' for older rows.
    plan: str = "free"
    # data: URI (see UpdateProfileRequest.avatarUrl) or None when the user has
    # never set one — the client falls back to initials.
    avatarUrl: str | None = None
    # MFA (Phase 7). mfaEnrolled is this membership's own state; the other two
    # are the CURRENT org's admin-mandatory policy, denormalized here (same
    # pattern as orgName/plan above) so the client can render
    # MfaRequiredBanner from the session it already has, with no extra round
    # trip to an admin-only settings endpoint.
    mfaEnrolled: bool = False
    orgRequireMfaForAdmins: bool = False
    orgMfaGracePeriodEndsAt: str | None = None


class OrgMembershipDTO(BaseModel):
    """One organization a user's identity belongs to (for the org switcher)."""

    orgId: str
    orgName: str
    roles: list[Role]
    active: bool = False


class MessageResponse(BaseModel):
    """Deliberately generic — used by non-enumerable flows (forgot-password,
    resend-verification) so the response never reveals whether an account exists."""
    message: str


class TokenVerifyResponse(BaseModel):
    valid: bool


class CaptchaChallengeDTO(BaseModel):
    """GET /auth/captcha's response. `captchaImage` is a `data:image/png;base64,...`
    URI — the rendered challenge, never the plaintext value it encodes."""

    captchaId: str
    captchaImage: str
    expiresIn: int


class SessionDTO(BaseModel):
    accessToken: str
    user: UserDTO
    expiresIn: int


class CreateInviteResponse(BaseModel):
    id: str


class InviteListItem(BaseModel):
    id: str
    email: str
    role: Role
    status: str
    expiresAt: str
    createdAt: str


class InviteVerifyResponse(BaseModel):
    email: str | None = None
    orgName: str | None = None
    valid: bool


# `removed` keeps the users row (messages, tasks, channel membership and audit
# entries all reference user_id — a hard delete would orphan every one of them)
# while revoking the membership. `suspended` is the reversible middle state.
MemberStatus = Literal["active", "suspended", "removed"]


class MemberDTO(BaseModel):
    """A member as the admin screen sees them: the directory fields plus the
    lifecycle state that `UserDTO` deliberately does not carry."""

    id: str
    username: str
    displayName: str
    email: str
    roles: list[Role]
    status: MemberStatus
    emailVerified: bool = True
    createdAt: str
    removedAt: str | None = None
    avatarUrl: str | None = None


class AuditEntryDTO(BaseModel):
    id: str
    actorId: str | None = None
    action: str
    target: str | None = None
    meta: dict | None = None
    at: str


class AuditPage(BaseModel):
    """Keyset page over audit_log, newest first. `nextCursor` is the id to pass
    back as `before`; null means the caller has reached the first entry.

    `id`/`nextCursor` are the audit_log uuid (UUIDv7, time-ordered) as of
    migrations/0018_audit_log_uuid_id.sql — previously the bigserial id
    stringified as an int.
    """

    entries: list[AuditEntryDTO]
    nextCursor: str | None = None


class DeleteOrgRequest(BaseModel):
    """Typed confirmation for org deletion — must equal the org's slug.

    A boolean flag would be trivially satisfied by a mis-scripted client or a
    stray click; echoing the name is the standard friction for an action with no
    undo, and it makes the intent unambiguous in the audit trail.
    """

    slug: str


class MfaPendingDTO(BaseModel):
    """Returned by /auth/login in place of a session when a second factor is
    still owed. `pendingToken` is a short-lived, single-use, server-only
    secret (never emailed) that the client presents to mfa_challenge.py's
    verify endpoint, and — while mfa_enrolled is still false — to the
    enroll-start/enroll-confirm endpoints in mfa_totp.py/mfa_webauthn.py (the
    restricted enrollment credential; see
    docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7)."""

    mfaRequired: bool = True
    pendingToken: str
    methods: list[Literal["totp", "webauthn"]]
    # True once past the org's mfa_grace_period_ends_at with no enrollment —
    # the client must route straight into enrollment, not a challenge screen.
    enrollmentRequired: bool = False


class MfaMethodsDTO(BaseModel):
    """Which second factors the CALLER (an already-signed-in, enrolled user)
    has registered — same shape/values as MfaPendingDTO.methods, but for an
    ordinary Bearer-authed caller rather than a pending login. Lets Settings
    decide whether to offer a passkey as a step-up shortcut without guessing
    from mfaEnrolled alone: a passkey-only enrollee has no TOTP secret or
    backup code to fall back on for MFA-disable / backup-codes regenerate."""

    methods: list[Literal["totp", "webauthn"]]


class MfaChallengeRequest(BaseModel):
    pendingToken: str = Field(min_length=1, max_length=512)
    # Exactly one of these three is set, matching whichever method the client
    # is presenting.
    totpCode: str | None = Field(default=None, min_length=6, max_length=10)
    backupCode: str | None = Field(default=None, min_length=1, max_length=32)
    webauthnCredential: dict | None = None


class MfaStepUpRequest(BaseModel):
    """Step-up re-auth shared by two consequential MFA actions — disabling MFA
    and regenerating backup codes: password + a still-valid second factor, so
    a stolen access token alone can never perform either. Exactly one of
    totpCode/backupCode/webauthnCredential should be set — mirrors
    MfaChallengeRequest's three-way choice, except a password is ALSO always
    required here (an already-signed-in caller has no earlier password check
    in this flow the way a fresh login does)."""

    password: str = Field(min_length=1, max_length=256)
    totpCode: str | None = Field(default=None, min_length=6, max_length=10)
    backupCode: str | None = Field(default=None, min_length=1, max_length=32)
    webauthnCredential: dict | None = None


class TotpEnrollStartRequest(BaseModel):
    # Present only when authenticating via the restricted enrollment
    # credential (see MfaPendingDTO); absent for an ordinary Bearer-authed
    # enrollment from Settings.
    pendingToken: str | None = Field(default=None, max_length=512)


class TotpEnrollStartResponse(BaseModel):
    secret: str
    otpauthUrl: str


class TotpEnrollConfirmRequest(BaseModel):
    # The secret round-trips from enroll-start through the client rather than
    # being persisted server-side before confirmation — see mfa_totp.py.
    secret: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=6, max_length=10)
    # Present only when authenticating via the restricted enrollment
    # credential (see MfaPendingDTO); absent for an ordinary Bearer-authed
    # enrollment from Settings.
    pendingToken: str | None = Field(default=None, max_length=512)


class TotpEnrollConfirmResponse(BaseModel):
    backupCodes: list[str]
    # Set only when this confirm was reached via the restricted enrollment
    # credential: enrollment mints the real session directly rather than
    # forcing a second round trip through challenge-verify.
    session: SessionDTO | None = None


class BackupCodesRegenerateResponse(BaseModel):
    backupCodes: list[str]


class WebauthnRegisterStartRequest(BaseModel):
    pendingToken: str | None = Field(default=None, max_length=512)


class WebauthnRegisterFinishRequest(BaseModel):
    credential: dict
    nickname: str | None = Field(default=None, max_length=80)
    pendingToken: str | None = Field(default=None, max_length=512)


class WebauthnRegisterFinishResponse(BaseModel):
    id: str
    nickname: str | None = None
    session: SessionDTO | None = None


class WebauthnAuthStartRequest(BaseModel):
    pendingToken: str = Field(min_length=1, max_length=512)


class OrgMfaSettingsRequest(BaseModel):
    requireMfaForAdmins: bool


class OrgMfaSettingsDTO(BaseModel):
    requireMfaForAdmins: bool
    mfaGracePeriodEndsAt: str | None = None


class OrgLifecycleDTO(BaseModel):
    """The org plus any pending deletion, for the countdown banner.

    All three timestamps are nullable and mean different things:
    `deleteRequestedAt` = someone asked, `purgeAfter` = when it stops being
    reversible, `deletedAt` = it already happened.
    """

    id: str
    name: str
    slug: str | None = None
    deleteRequestedAt: str | None = None
    purgeAfter: str | None = None
    deletedAt: str | None = None
