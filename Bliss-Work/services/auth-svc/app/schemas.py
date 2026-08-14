"""Request/response models matching the canonical TS contract DTOs."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, EmailStr, Field

Role = Literal["org_admin", "member"]


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


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


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
    displayName: str = Field(min_length=1, max_length=80)


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


class AuditEntryDTO(BaseModel):
    id: int
    actorId: str | None = None
    action: str
    target: str | None = None
    meta: dict | None = None
    at: str


class AuditPage(BaseModel):
    """Keyset page over audit_log, newest first. `nextCursor` is the id to pass
    back as `before`; null means the caller has reached the first entry."""

    entries: list[AuditEntryDTO]
    nextCursor: int | None = None


class DeleteOrgRequest(BaseModel):
    """Typed confirmation for org deletion — must equal the org's slug.

    A boolean flag would be trivially satisfied by a mis-scripted client or a
    stray click; echoing the name is the standard friction for an action with no
    undo, and it makes the intent unambiguous in the audit trail.
    """

    slug: str


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
