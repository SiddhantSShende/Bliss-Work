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
    username: str
    displayName: str
    email: str
    roles: list[Role]
    emailVerified: bool = True


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
