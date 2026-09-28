"""ThemePrefs — the synced UI theme carried on PATCH /auth/me and GET /auth/me.

The server keeps no list of valid theme ids (the clients validate against their
own on read), so what it must guarantee is only that the stored document is
small and well-formed: a short id token and 1-3 #rrggbb colours. Anything else
is refused at the boundary rather than persisted and echoed to every device.
"""
from __future__ import annotations

import pytest

schemas = pytest.importorskip(
    "app.schemas",
    reason="auth-svc deps (fastapi/pydantic) not installed locally; CI installs requirements.txt.",
)
ThemePrefs = schemas.ThemePrefs
UpdateProfileRequest = schemas.UpdateProfileRequest
UserDTO = schemas.UserDTO
ValidationError = pytest.importorskip("pydantic").ValidationError


def test_accepts_a_preset_light_and_dark_id():
    assert ThemePrefs(theme="rose").customColors is None
    assert ThemePrefs(theme="bluePurple-dark").theme == "bluePurple-dark"


def test_accepts_a_custom_palette_of_one_to_three_colours():
    for colors in (["#6366f1"], ["#6366f1", "#ff00aa"], ["#000000", "#ffffff", "#ABCDEF"]):
        assert ThemePrefs(theme="blue", customColors=colors, customActive=True).customColors == colors


@pytest.mark.parametrize("bad", ["", "rose dark", "rose-dark-dark", "a" * 33, "../etc", "rose;drop", "12", "rose\n"])
def test_rejects_a_malformed_theme_id(bad):
    with pytest.raises(ValidationError):
        ThemePrefs(theme=bad)


@pytest.mark.parametrize(
    "colors",
    [[], ["#fff"], ["red"], ["#gggggg"], ["#6366f1"] * 4, ["#6366f1", "javascript:alert(1)"], ["#6366f1 "], ["#6366f1\n"]],
)
def test_rejects_malformed_custom_colours(colors):
    with pytest.raises(ValidationError):
        ThemePrefs(theme="blue", customColors=colors)


def test_custom_colours_are_optional_and_inactive_by_default():
    prefs = ThemePrefs(theme="teal")
    assert (prefs.customColors, prefs.customActive) == (None, False)


def test_profile_request_takes_theme_prefs_independently_of_name_and_avatar():
    body = UpdateProfileRequest(themePrefs={"theme": "lime", "customColors": ["#65a30d"], "customActive": False})
    assert body.displayName is None and body.avatarUrl is None
    assert body.themePrefs.theme == "lime"
    assert UpdateProfileRequest(displayName="Ada").themePrefs is None


def test_user_dto_defaults_theme_prefs_to_none_for_listings():
    dto = UserDTO(id="u", orgId="o", username="ada", displayName="Ada", email="a@x.io", roles=["member"])
    assert dto.themePrefs is None


# ── Through the real error handler ───────────────────────────────────────────
# A ValueError raised inside a field_validator ends up in the pydantic error's
# `ctx`, which errors.py's validation handler cannot JSON-encode — bad input
# became a 500 instead of a 422 (seen live before ThemePrefs switched to native
# `pattern` constraints). The model-level tests above cannot see that; only a
# request that goes through the handler can.
def _client():
    fastapi = pytest.importorskip("fastapi")
    testclient = pytest.importorskip("fastapi.testclient")
    errors = pytest.importorskip("app.errors")
    app = fastapi.FastAPI()
    errors.register_exception_handlers(app)

    @app.patch("/me")
    async def patch_me(body: UpdateProfileRequest):
        return {"themePrefs": body.themePrefs.model_dump() if body.themePrefs else None}

    return testclient.TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "bad",
    [
        {"theme": "../x"},
        {"theme": "rose\n"},
        {"theme": "a" * 40},
        {"theme": "rose", "customColors": ["red"]},
        {"theme": "rose", "customColors": ["#6366f1\n"]},
        {"theme": "rose", "customColors": []},
        {"theme": "rose", "customColors": ["#111111"] * 4},
    ],
)
def test_bad_theme_prefs_are_a_422_not_a_500(bad):
    res = _client().patch("/me", json={"themePrefs": bad})
    assert res.status_code == 422, res.text
    assert res.json()["error"]["code"] == "validation_error"


def test_good_theme_prefs_round_trip_through_the_endpoint():
    good = {"theme": "rose-dark", "customColors": ["#ffee00"], "customActive": True}
    res = _client().patch("/me", json={"themePrefs": good})
    assert res.status_code == 200
    assert res.json()["themePrefs"] == good


# ── Only /auth/me may carry it ───────────────────────────────────────────────
# service.user_dto also backs GET /auth/users/{id} for colleagues, so attaching
# themePrefs is opt-in. Probed live: the endpoint used to return it.
class _Row:
    id = "u1"
    org_id = "o1"
    username = "ada"
    display_name_enc = b"n"
    email_enc = b"e"
    avatar_enc = None
    email_verified = True
    mfa_enrolled = False
    theme_prefs = {"theme": "rose", "customColors": None, "customActive": False}
    plan = "free"
    org_name = "Acme"
    require_mfa_for_admins = False
    mfa_grace_period_ends_at = None


class _Result:
    def first(self):
        return _Row()


class _Conn:
    async def execute(self, *_a, **_k):
        return _Result()


class _Cryptor:
    async def decrypt(self, _conn, _org, enc):
        return enc.decode() if enc else None


@pytest.fixture
def service(monkeypatch):
    service = pytest.importorskip("app.service")

    async def roles(_conn, _uid):
        return ["member"]

    monkeypatch.setattr(service, "cryptor", lambda: _Cryptor())
    monkeypatch.setattr(service, "roles_for_user", roles)
    return service


async def test_user_dto_omits_theme_prefs_unless_asked(service):
    assert (await service.user_dto(_Conn(), "u1")).themePrefs is None


async def test_user_dto_includes_theme_prefs_for_me(service):
    dto = await service.user_dto(_Conn(), "u1", with_theme_prefs=True)
    assert dto.themePrefs.theme == "rose"


async def test_user_dto_with_no_stored_prefs_is_none_even_when_asked(service, monkeypatch):
    monkeypatch.setattr(_Row, "theme_prefs", None)
    assert (await service.user_dto(_Conn(), "u1", with_theme_prefs=True)).themePrefs is None
